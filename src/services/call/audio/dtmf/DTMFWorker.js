// services/call/audio/dtmf/DTMFWorker.js
//
// Worker thread for DTMF digit detection via Goertzel algorithm.
// One instance per PM2 process, shared across all concurrent IVR sessions.
// Runs in a separate V8 context so Goertzel computation never blocks the main
// event loop.
//
// ── Message protocol ─────────────────────────────────────────────────────────
//  Main → Worker
//    { type: 'start',  callId }
//    { type: 'frame',  callId, buffer: ArrayBuffer, sampleRate: number }
//    { type: 'reset',  callId, full?: boolean }
//    { type: 'stop',   callId }
//
//  Worker → Main
//    { type: 'ready' }
//    { type: 'digit',  callId, digit, rowHz, colHz }
//    { type: 'error',  callId, message }
// ─────────────────────────────────────────────────────────────────────────────
import { parentPort } from 'worker_threads';
import { DTMFDetector } from './DTMFDetector.js';

// callId -> DTMFDetector
const sessions = new Map();

parentPort.postMessage({ type: 'ready' });

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
            if (sessions.has(msg.callId)) {
                parentPort.postMessage({
                    type: 'error',
                    callId: msg.callId,
                    message: `Duplicate start for session ${msg.callId}`,
                });
                break;
            }
            sessions.set(msg.callId, new DTMFDetector());
            break;
        }

        case 'frame': {
            const detector = sessions.get(msg.callId);
            if (!detector) break; // silently skip — session already stopped

            try {
                const samples = new Int16Array(msg.buffer);
                const result = detector.process(samples, msg.sampleRate);
                if (result) {
                    parentPort.postMessage({
                        type: 'digit',
                        callId: msg.callId,
                        digit: result.digit,
                        rowHz: result.rowHz,
                        colHz: result.colHz,
                    });
                }
            } catch (err) {
                parentPort.postMessage({
                    type: 'error',
                    callId: msg.callId,
                    message: `Frame processing failed: ${err.message}`,
                });
            }
            break;
        }

        case 'reset': {
            const detector = sessions.get(msg.callId);
            if (detector) detector.reset({ full: !!msg.full });
            break;
        }

        case 'stop': {
            sessions.delete(msg.callId);
            break;
        }
    }
}
