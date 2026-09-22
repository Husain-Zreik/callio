// src/services/call/audio/recording/encoding/EncodingWorker.js
//
// Worker thread for stereo mixing, Opus encoding, and OGG muxing.
// Owns the StereoMixBuffer so the main thread only copies the raw mono PCM
// and transfers it zero-copy — no mix work runs on the main event loop.
//
// ── Message protocol ────────────────────────────────────────────────────────
//  Main → Worker
//    { type: 'start',  callId }
//      — init mix buffer + encoder + muxer
//    { type: 'audio',  callId, channel: 'agent'|'customer', buffer: ArrayBuffer }
//      — one mono 16-bit PCM chunk; mix buffer interleaves and encodes complete frames
//    { type: 'reset',  callId }
//      — discard buffered PCM + reset encoder (agent track replacement)
//    { type: 'stop',   callId }
//      — flush mix buffer + encoder, write OGG EOS page, ACK
//
//  Worker → Main
//    { type: 'ready',   opusAvailable }               — once on startup
//    { type: 'chunk',   callId, buffer: ArrayBuffer } — one OGG page (transferred)
//    { type: 'stopped', callId }                      — all chunks sent, EOS written
//    { type: 'error',   callId, message }             — per-session error (non-fatal)
// ────────────────────────────────────────────────────────────────────────────
import { parentPort } from 'worker_threads';
import { PcmOpusEncoder, opusAvailable } from './OpusEncoder.js';
import { OggMuxer } from './OggMuxer.js';
import { StereoMixBuffer } from '../StereoMixBuffer.js';

// callId -> { encoder: PcmOpusEncoder, muxer: OggMuxer, mixBuf: StereoMixBuffer }
const sessions = new Map();

parentPort.postMessage({ type: 'ready', opusAvailable });

parentPort.on('message', (msg) => {
    try {
        handle(msg);
    } catch (err) {
        parentPort.postMessage({ type: 'error', callId: msg?.callId, message: err.message });
    }
});

function handle(msg) {
    switch (msg.type) {

        case 'start': {
            try {
                if (sessions.has(msg.callId)) {
                    parentPort.postMessage({
                        type: 'error',
                        callId: msg.callId,
                        message: `Duplicate start for session ${msg.callId}`,
                    });
                    break;
                }

                const encoder = new PcmOpusEncoder();
                const muxer = new OggMuxer();
                const mixBuf = new StereoMixBuffer();

                muxer.on('data', (chunk) => _sendChunk(msg.callId, chunk));
                sessions.set(msg.callId, { encoder, muxer, mixBuf });

                // Fires 'data' twice (OGG ID + Comment pages) synchronously.
                muxer.writeHeaders();

            } catch (err) {
                sessions.delete(msg.callId);
                parentPort.postMessage({
                    type: 'error',
                    callId: msg.callId,
                    message: `Session start failed: ${err.message}`,
                });
            }
            break;
        }

        case 'audio': {
            try {
                const session = sessions.get(msg.callId);
                if (!session) break;

                const { encoder, muxer, mixBuf } = session;

                // Push mono PCM into the mix buffer; get back complete stereo frames.
                const frames = mixBuf.push(msg.channel, Buffer.from(msg.buffer));
                for (const frame of frames) {
                    const packets = encoder.encode(frame);
                    for (const packet of packets) muxer.writePacket(packet);
                }
            } catch (err) {
                parentPort.postMessage({
                    type: 'error',
                    callId: msg.callId,
                    message: `Encode failed: ${err.message}`,
                });
            }
            break;
        }

        case 'reset': {
            try {
                const session = sessions.get(msg.callId);
                if (session) {
                    session.mixBuf.reset();
                    session.encoder.reset();
                }
            } catch (err) {
                parentPort.postMessage({
                    type: 'error',
                    callId: msg.callId,
                    message: `Reset failed: ${err.message}`,
                });
            }
            break;
        }

        case 'track_active': {
            const session = sessions.get(msg.callId);
            if (session) session.mixBuf.setTrackActive(msg.channel, msg.active);
            break;
        }

        case 'stop': {
            try {
                const session = sessions.get(msg.callId);
                if (!session) {
                    parentPort.postMessage({ type: 'stopped', callId: msg.callId });
                    break;
                }

                const { encoder, muxer, mixBuf } = session;

                // 1. Flush the mix buffer — encodes any remaining complete or partial
                //    stereo frame (mix buffer pads the shorter channel with silence).
                const lastStereoFrame = mixBuf.flush();
                if (lastStereoFrame) {
                    const packets = encoder.encode(lastStereoFrame);
                    for (const packet of packets) muxer.writePacket(packet);
                }

                // 2. Flush the Opus encoder (pads the last partial PCM frame).
                const finalPacket = encoder.flush();

                // 3. Write OGG EOS page; fires 'data' synchronously so ALL 'chunk'
                //    messages are queued before 'stopped' below.
                muxer.finalize(finalPacket);

                sessions.delete(msg.callId);
                parentPort.postMessage({ type: 'stopped', callId: msg.callId });
                console.log(`[EncodingWorker] Session stopped: ${msg.callId} (active=${sessions.size})`);

            } catch (err) {
                sessions.delete(msg.callId);
                parentPort.postMessage({
                    type: 'error',
                    callId: msg.callId,
                    message: `Stop/finalize failed: ${err.message}`,
                });
            }
            break;
        }
    }
}

function _sendChunk(callId, chunk) {
    const ab = new ArrayBuffer(chunk.length);
    new Uint8Array(ab).set(chunk);
    parentPort.postMessage({ type: 'chunk', callId, buffer: ab }, [ab]);
}
