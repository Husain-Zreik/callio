// src/services/call/audio/recording/encoding/OpusEncoder.js

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_DURATION = 20;
const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION) / 1000; // 960 samples per channel
const BYTES_PER_SAMPLE = 2;
const FRAME_BYTES = FRAME_SIZE * BYTES_PER_SAMPLE * CHANNELS; // 3840 bytes (stereo)

// Try to load native Opus bindings — fails gracefully on Windows dev machines
let OpusEncoder = null;
try {
    const pkg = await import('@discordjs/opus');
    OpusEncoder = pkg.default?.OpusEncoder ?? pkg.OpusEncoder;
    console.log('[OpusEncoder] ✅ Native Opus bindings loaded');
} catch (err) {
    console.warn('[OpusEncoder] ⚠️ Native Opus bindings not available — encoding disabled:', err.message);
}

/**
 * Whether Opus encoding is available in this environment.
 * RecordingSession checks this before creating encoders.
 */
export const opusAvailable = !!OpusEncoder;

export class PcmOpusEncoder {
    constructor() {
        if (!OpusEncoder) {
            throw new Error('Opus not available in this environment');
        }
        this.encoder    = new OpusEncoder(SAMPLE_RATE, CHANNELS);
        this.frameSize  = FRAME_SIZE;
        this.frameBytes = FRAME_BYTES;
        // Pre-allocated ring buffer — avoids Buffer.concat on every encode call.
        // Sized for 2 frames so partial chunks never need reallocation.
        this._ring    = Buffer.allocUnsafe(FRAME_BYTES * 2);
        this._ringLen = 0;
    }

    /**
     * Encode a PCM chunk into one or more Opus packets.
     * @param {Buffer} pcmChunk - Stereo 16-bit PCM, must be a multiple of 4 bytes
     * @returns {Buffer[]}
     */
    encode(pcmChunk) {
        const packets = [];
        let inputOffset = 0;

        while (inputOffset < pcmChunk.length) {
            const needed = this.frameBytes - this._ringLen;
            const avail  = pcmChunk.length - inputOffset;
            const toCopy = Math.min(needed, avail);

            pcmChunk.copy(this._ring, this._ringLen, inputOffset, inputOffset + toCopy);
            this._ringLen += toCopy;
            inputOffset   += toCopy;

            if (this._ringLen === this.frameBytes) {
                packets.push(this.encoder.encode(this._ring.subarray(0, this.frameBytes)));
                this._ringLen = 0;
            }
        }

        return packets;
    }

    /**
     * Flush remaining buffered PCM, padded with silence.
     * @returns {Buffer|null}
     */
    flush() {
        if (this._ringLen === 0) return null;
        // Silence-pad the remaining bytes in the ring buffer
        this._ring.fill(0, this._ringLen, this.frameBytes);
        const packet  = this.encoder.encode(this._ring.subarray(0, this.frameBytes));
        this._ringLen = 0;
        return packet;
    }

    /**
     * Reset encoder state (on agent track replacement)
     */
    reset() {
        this._ringLen = 0;
        this.encoder  = new OpusEncoder(SAMPLE_RATE, CHANNELS);
        console.log('[OpusEncoder] Reset');
    }

    getFrameSize()  { return this.frameSize; }
    getSampleRate() { return SAMPLE_RATE; }
    getChannels()   { return CHANNELS; }
}
