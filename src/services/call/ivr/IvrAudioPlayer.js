// services/call/ivr/IvrAudioPlayer.js
//
// Single responsibility: fetch an audio file (WAV/MP3/OGG/WebM) from local disk
// or a URL, decode it to 48 kHz mono Int16 PCM, then push 10 ms frames
// through an RTCAudioSource — identical mechanism to PlaceholderTrackFactory.
//
// WAV (PCM-16) files are parsed directly (fast path).
// All other formats are transcoded via ffmpeg-static (spawn once, stream stdout).
//
// Returns a Promise that resolves when playback ends (for auto-advance in
// ivr_play nodes).  Exposes stop() to abort early (for ivr_menu timeout).
import fs from 'fs';
import { spawn } from 'child_process';
import https from 'https';
import http from 'http';

let ffmpegPath = null;
try {
    const { default: fp } = await import('ffmpeg-static');
    ffmpegPath = fp;
    console.log('[IvrAudioPlayer] ffmpeg available at:', ffmpegPath);
} catch {
    console.warn('[IvrAudioPlayer] ffmpeg-static not found — only WAV will play correctly');
}

const SAMPLE_RATE = 48000;
const FRAME_SIZE = 480;   // 10 ms at 48 kHz
const FRAME_INTERVAL = 10;    // ms

class IvrAudioPlayer {
    constructor(audioSource = null) {
        this._audioSource = audioSource;
        this._interval = null;
        this._ffmpeg = null;
        this._resolve = null;
        this._reject = null;
        this._stopped = false;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Play an audio file.  Resolves when playback ends.
     *
     * @param {string} filePath  Absolute local path or http(s) URL
     * @returns {Promise<void>}
     */
    /**
     * Play an audio file or pre-loaded Buffer.
     *
     * @param {string|Buffer} input  Absolute local path, http(s) URL, or Buffer
     * @returns {Promise<void>}
     */
    play(input) {
        const label = (input instanceof Int16Array)
            ? `<pcm ${input.length} samples>`
            : Buffer.isBuffer(input) ? `<buffer ${input.length}b>` : input;
        console.log(`[IvrAudioPlayer] play() → ${label}`);
        return new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;

            // Pre-decoded PCM fast-path — skip ffmpeg entirely
            if (input instanceof Int16Array) {
                this._startPlayback(input);
                return;
            }

            const loadPromise = Buffer.isBuffer(input)
                ? this._decodeViaFfmpegStdin(input, label)
                : this._loadPcm(input);

            loadPromise
                .then((samples) => {
                    console.log(`[IvrAudioPlayer] loaded ${samples.length} samples for ${label}`);
                    this._startPlayback(samples);
                })
                .catch((err) => {
                    console.error('[IvrAudioPlayer] Load failed:', err.message, '| file:', label);
                    // On load failure, resolve after a brief silence (don't crash the flow)
                    this._playSilence(resolve);
                });
        });
    }

    /**
     * Decode an audio file to 48 kHz mono Int16Array PCM without playing it.
     * Call once at startup; the returned PCM can be replayed via play() with zero ffmpeg cost.
     *
     * @param {string|Buffer} input  Local path, http(s) URL, or raw audio Buffer
     * @returns {Promise<Int16Array>}
     */
    static async decode(input) {
        const tmp = new IvrAudioPlayer(null);
        if (Buffer.isBuffer(input)) return tmp._decodeViaFfmpegStdin(input, '<buffer>');
        return tmp._loadPcm(input);
    }

    /** Stop playback early. */
    stop() {
        this._stopped = true;
        if (this._interval) {
            clearTimeout(this._interval);
            this._interval = null;
        }
        if (this._ffmpeg) {
            try { this._ffmpeg.kill('SIGKILL'); } catch { }
            this._ffmpeg = null;
        }
        if (this._resolve) {
            const r = this._resolve;
            this._resolve = null;
            this._reject = null;
            r();
        }
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    _startPlayback(samples) {
        let offset = 0;
        const total = samples.length;
        const frame = new Int16Array(FRAME_SIZE);

        // High-resolution start time via process.hrtime so we are not affected by
        // the OS timer resolution (~15.6 ms on Windows) that makes setInterval(fn,10)
        // fire every ~15 ms instead of 10 ms, causing audio to play at 0.67× speed.
        const startHr = process.hrtime();
        const getElapsedMs = () => {
            const [s, ns] = process.hrtime(startHr);
            return s * 1000 + ns / 1e6;
        };

        const tick = () => {
            if (this._stopped || !this._resolve) return;

            // Calculate how many samples SHOULD have been sent by now.
            const targetOffset = Math.min(
                Math.floor(getElapsedMs() * SAMPLE_RATE / 1000),
                total,
            );

            // Catch up: push all overdue frames in one burst if the timer fired late.
            while (offset < targetOffset) {
                const toCopy = Math.min(FRAME_SIZE, total - offset);
                if (toCopy <= 0) break;

                frame.set(samples.subarray(offset, offset + toCopy));
                if (toCopy < FRAME_SIZE) frame.fill(0, toCopy); // zero-pad last frame

                this._audioSource.onData({
                    samples: frame,
                    sampleRate: SAMPLE_RATE,
                    numberOfFrames: FRAME_SIZE,
                    channelCount: 1,
                });
                offset += toCopy;
            }

            if (offset >= total) {
                this._interval = null;
                const r = this._resolve;
                this._resolve = null;
                this._reject = null;
                if (r) r();
                return;
            }

            // Schedule the next tick for exactly when the next frame should start.
            const nextFrameMs = (offset / SAMPLE_RATE) * 1000;
            const delayMs = Math.max(1, nextFrameMs - getElapsedMs());
            this._interval = setTimeout(tick, delayMs);
        };

        this._interval = setTimeout(tick, 0);
    }

    /** Play ~1 second of silence then resolve — used as fallback on load error. */
    _playSilence(resolve) {
        // If stop() was already called (e.g. DTMF fired during load), don't push
        // silence frames — they would corrupt the next node's audio on the same source.
        if (this._stopped) { resolve(); return; }

        const silence = new Int16Array(FRAME_SIZE);
        let ticks = 100; // 100 × 10 ms = 1 s
        const iv = setInterval(() => {
            if (this._stopped) { clearInterval(iv); resolve(); return; }
            this._audioSource.onData({
                samples: silence,
                sampleRate: SAMPLE_RATE,
                numberOfFrames: FRAME_SIZE,
                channelCount: 1,
            });
            if (--ticks <= 0) { clearInterval(iv); resolve(); }
        }, FRAME_INTERVAL);
    }

    /**
     * Load a local file or HTTP(S) URL into a raw PCM Int16Array at 48 kHz mono.
     *
     * Always prefers ffmpeg when available — it handles sample-rate conversion,
     * stereo → mono downmix, and all compressed formats (WebM, OGG, MP3, M4A…).
     * The manual WAV parser is only used as a last resort when ffmpeg is absent.
     *
     * @param {string} src
     * @returns {Promise<Int16Array>}
     */
    async _loadPcm(src) {
        // Prefer ffmpeg for ALL formats: it correctly resamples to 48 kHz and
        // downmixes stereo to mono, avoiding pitch/speed distortion from raw PCM reads.
        if (ffmpegPath) {
            // ffmpeg-static may not be able to open HTTP(S) URLs directly (SSL/network
            // restrictions). Pre-fetch via Node.js's native https module, which uses
            // the OS TLS stack, and pipe the buffer to ffmpeg via stdin instead.
            if (src.startsWith('http://') || src.startsWith('https://')) {
                const buf = await this._fetchUrl(src);
                return this._decodeViaFfmpegStdin(buf, src);
            }
            return this._decodeViaFfmpeg(src);
        }

        // No ffmpeg: attempt manual WAV parsing for .wav/.pcm files only.
        const isWav = src.toLowerCase().endsWith('.wav') ||
            src.toLowerCase().endsWith('.pcm');
        if (isWav) {
            const buf = src.startsWith('http://') || src.startsWith('https://')
                ? await this._fetchUrl(src)
                : await fs.promises.readFile(src);
            return this._decodeWav(buf);
        }

        // Fallback: no ffmpeg, non-WAV — read as raw bytes (will sound garbled)
        console.warn('[IvrAudioPlayer] ffmpeg not available — audio may be garbled for non-WAV files');
        const buf = src.startsWith('http://') || src.startsWith('https://')
            ? await this._fetchUrl(src)
            : await fs.promises.readFile(src);
        return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
    }

    /**
     * Decode any audio file to 48 kHz mono Int16 PCM via ffmpeg.
     * Accepts a local file path or http(s) URL as input.
     */
    _decodeViaFfmpeg(src) {
        return new Promise((resolve, reject) => {
            const args = [
                '-fflags', '+genpts+discardcorrupt', // handle browser-recorded WebM with N/A duration
                '-i', src,
                '-f', 's16le',       // raw signed 16-bit little-endian PCM
                '-ar', String(SAMPLE_RATE),
                '-ac', '1',          // mono
                '-vn',               // no video
                'pipe:1',            // output to stdout
            ];

            console.log(`[IvrAudioPlayer] ffmpeg spawn: ${ffmpegPath} ${args.join(' ')}`);
            const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
            this._ffmpeg = proc;

            const chunks = [];
            const errChunks = [];
            proc.stdout.on('data', (chunk) => chunks.push(chunk));
            proc.stderr.on('data', (chunk) => errChunks.push(chunk));
            proc.stdout.on('end', () => {
                this._ffmpeg = null;
                const buf = Buffer.concat(chunks);
                if (buf.length === 0) {
                    const errMsg = Buffer.concat(errChunks).toString().slice(-300);
                    console.error('[IvrAudioPlayer] ffmpeg produced no output. stderr:', errMsg);
                    reject(new Error('ffmpeg produced no output'));
                    return;
                }
                console.log(`[IvrAudioPlayer] ffmpeg decoded ${buf.length} bytes (${Math.floor(buf.length / 2)} samples)`);
                resolve(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
            });
            proc.on('error', (err) => {
                console.error('[IvrAudioPlayer] ffmpeg process error:', err.message);
                this._ffmpeg = null;
                reject(err);
            });
            proc.on('close', (code) => {
                if (code !== 0) {
                    const errMsg = Buffer.concat(errChunks).toString().slice(-200);
                    console.warn(`[IvrAudioPlayer] ffmpeg exited code=${code}, stderr tail: ${errMsg}`);
                }
            });
        });
    }

    /**
     * Decode a pre-fetched audio Buffer to 48 kHz mono Int16 PCM via ffmpeg stdin.
     * Used for HTTP(S) sources that ffmpeg-static cannot open directly.
     *
     * @param {Buffer} buf   raw audio file bytes
     * @param {string} [label]  original source label for logging
     * @returns {Promise<Int16Array>}
     */
    _decodeViaFfmpegStdin(buf, label = '<buffer>') {
        return new Promise((resolve, reject) => {
            const args = [
                '-fflags', '+genpts+discardcorrupt',
                '-i', 'pipe:0',
                '-f', 's16le',
                '-ar', String(SAMPLE_RATE),
                '-ac', '1',
                '-vn',
                'pipe:1',
            ];

            console.log(`[IvrAudioPlayer] ffmpeg stdin-decode: ${buf.length} bytes from ${label}`);
            const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            this._ffmpeg = proc;

            const chunks = [];
            const errChunks = [];
            proc.stdout.on('data', (chunk) => chunks.push(chunk));
            proc.stderr.on('data', (chunk) => errChunks.push(chunk));
            proc.stdout.on('end', () => {
                this._ffmpeg = null;
                const outBuf = Buffer.concat(chunks);
                if (outBuf.length === 0) {
                    const errMsg = Buffer.concat(errChunks).toString().slice(-300);
                    console.error('[IvrAudioPlayer] ffmpeg (stdin) produced no output. stderr:', errMsg);
                    reject(new Error('ffmpeg produced no output'));
                    return;
                }
                console.log(`[IvrAudioPlayer] ffmpeg (stdin) decoded ${outBuf.length} bytes (${Math.floor(outBuf.length / 2)} samples)`);
                resolve(new Int16Array(outBuf.buffer, outBuf.byteOffset, Math.floor(outBuf.length / 2)));
            });
            proc.on('error', (err) => {
                console.error('[IvrAudioPlayer] ffmpeg (stdin) process error:', err.message);
                this._ffmpeg = null;
                reject(err);
            });
            proc.on('close', (code) => {
                if (code !== 0) {
                    const errMsg = Buffer.concat(errChunks).toString().slice(-200);
                    console.warn(`[IvrAudioPlayer] ffmpeg (stdin) exited code=${code}, stderr tail: ${errMsg}`);
                }
            });

            // Ignore EPIPE in case stop() kills the process before write completes.
            proc.stdin.on('error', () => { });
            proc.stdin.end(buf);
        });
    }

    _fetchUrl(url, redirectsLeft = 5) {
        return new Promise((resolve, reject) => {
            const proto = url.startsWith('https://') ? https : http;
            proto.get(url, (res) => {
                const { statusCode, headers } = res;

                // Follow redirects (S3 presigned URLs occasionally redirect).
                if (statusCode >= 300 && statusCode < 400 && headers.location) {
                    res.resume(); // drain so socket is reused
                    if (redirectsLeft <= 0) {
                        return reject(new Error(`Too many redirects fetching audio URL`));
                    }
                    return this._fetchUrl(headers.location, redirectsLeft - 1)
                        .then(resolve, reject);
                }

                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    if (statusCode < 200 || statusCode >= 300) {
                        const body = buf.toString('utf8').slice(0, 400);
                        console.error(`[IvrAudioPlayer] HTTP ${statusCode} fetching audio. Body: ${body}`);
                        return reject(new Error(`HTTP ${statusCode} fetching audio`));
                    }
                    resolve(buf);
                });
                res.on('error', reject);
            }).on('error', reject);
        });
    }

    /**
     * Decode a WAV buffer to Int16Array PCM at 48 kHz mono.
     * Handles RIFF WAV header; falls back to raw PCM.
     */
    _decodeWav(buf) {
        if (buf.length > 44 &&
            buf.toString('ascii', 0, 4) === 'RIFF' &&
            buf.toString('ascii', 8, 12) === 'WAVE') {
            return this._parseWav(buf);
        }
        return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
    }

    _parseWav(buf) {
        let pos = 12;
        while (pos + 8 < buf.length) {
            const chunkId = buf.toString('ascii', pos, pos + 4);
            const chunkSize = buf.readUInt32LE(pos + 4);
            if (chunkId === 'data') {
                const start = pos + 8;
                const length = Math.min(chunkSize, buf.length - start);
                return new Int16Array(
                    buf.buffer,
                    buf.byteOffset + start,
                    Math.floor(length / 2)
                );
            }
            pos += 8 + chunkSize;
        }
        return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
    }
}

export { IvrAudioPlayer };
