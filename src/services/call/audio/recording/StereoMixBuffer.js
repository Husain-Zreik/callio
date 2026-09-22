// src/services/call/audio/recording/StereoMixBuffer.js
//
// Synchronizes two independent PCM streams (agent + customer) before
// interleaving them into stereo frames for Opus encoding.
//
// Channel convention (matches AWS Connect):
//   Left  (ch0) = customer
//   Right (ch1) = agent

const FRAME_SIZE         = 960;   // samples per channel per 20ms frame at 48kHz
const FRAME_BYTES        = 1920;  // FRAME_SIZE * 2 bytes (16-bit PCM)
const STEREO_FRAME_BYTES = 3840;  // FRAME_SIZE * 2 channels * 2 bytes

// Maximum backlog per side: 10 frames (200ms). Covers any realistic jitter
// between the two audio tracks without dynamic reallocation.
const MAX_BACKLOG_BYTES = FRAME_BYTES * 10;

// Shared zero buffer used as a silence slot when one side is inactive.
// Never written to — only passed as a read-only input to _interleave().
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES);

export class StereoMixBuffer {
    constructor() {
        this._agentBuf    = Buffer.allocUnsafe(MAX_BACKLOG_BYTES);
        this._customerBuf = Buffer.allocUnsafe(MAX_BACKLOG_BYTES);
        this._agentLen    = 0;
        this._customerLen = 0;

        // Tracks whether each side is actively sending data.
        // When a track is inactive, its slot is filled with silence
        // so the active track is not blocked.
        this.agentActive    = true;
        this.customerActive = true;
    }

    /**
     * Mark a track as active or inactive.
     * Call with (trackType, false) when the agent disconnects.
     * Call with (trackType, true) when the agent reconnects.
     */
    setTrackActive(trackType, active) {
        if (trackType === 'agent') this.agentActive    = active;
        else                       this.customerActive = active;
    }

    /**
     * Push a PCM chunk for one track.
     * Returns an array of ready stereo frames (Buffer[], may be empty).
     * Each returned frame is STEREO_FRAME_BYTES bytes of interleaved 16-bit PCM:
     *   [L0 L0 R0 R0  L1 L1 R1 R1  ...]
     */
    push(trackType, pcmChunk) {
        if (trackType === 'agent') {
            pcmChunk.copy(this._agentBuf, this._agentLen);
            this._agentLen += pcmChunk.length;
        } else {
            pcmChunk.copy(this._customerBuf, this._customerLen);
            this._customerLen += pcmChunk.length;
        }
        return this._drainFrames();
    }

    /**
     * Flush remaining buffered data at end of call.
     * Pads the shorter side with silence, returns one final stereo frame or null.
     */
    flush() {
        if (this._agentLen === 0 && this._customerLen === 0) return null;

        const agentPadded    = Buffer.alloc(FRAME_BYTES);
        const customerPadded = Buffer.alloc(FRAME_BYTES);

        this._agentBuf.copy(agentPadded,    0, 0, Math.min(this._agentLen,    FRAME_BYTES));
        this._customerBuf.copy(customerPadded, 0, 0, Math.min(this._customerLen, FRAME_BYTES));

        this._agentLen    = 0;
        this._customerLen = 0;

        return this._interleave(customerPadded, agentPadded);
    }

    /**
     * Reset both buffers (called on agent track replacement to discard stale PCM).
     */
    reset() {
        this._agentLen    = 0;
        this._customerLen = 0;
    }

    // ─── Private ────────────────────────────────────────────────────────────

    _drainFrames() {
        const frames = [];

        while (true) {
            const agentHasFrame    = this._agentLen    >= FRAME_BYTES;
            const customerHasFrame = this._customerLen >= FRAME_BYTES;

            // A side is "ready" if it either has a full frame, or is paused (silence fills in).
            const agentReady    = agentHasFrame    || !this.agentActive;
            const customerReady = customerHasFrame || !this.customerActive;

            // Both sides must be ready before we can emit a frame.
            if (!agentReady || !customerReady) break;

            // At least one side must have real data — avoid an infinite silence loop.
            if (!agentHasFrame && !customerHasFrame) break;

            const agentFrame    = agentHasFrame    ? this._agentBuf.subarray(0, FRAME_BYTES)    : SILENCE_FRAME;
            const customerFrame = customerHasFrame ? this._customerBuf.subarray(0, FRAME_BYTES) : SILENCE_FRAME;

            frames.push(this._interleave(customerFrame, agentFrame));

            // Compact the buffers by shifting remaining data to the front.
            if (agentHasFrame) {
                this._agentBuf.copyWithin(0, FRAME_BYTES, this._agentLen);
                this._agentLen -= FRAME_BYTES;
            }
            if (customerHasFrame) {
                this._customerBuf.copyWithin(0, FRAME_BYTES, this._customerLen);
                this._customerLen -= FRAME_BYTES;
            }
        }

        return frames;
    }

    /**
     * Interleave two mono 16-bit PCM frames into one stereo frame.
     * leftFrame  → ch0 (customer)
     * rightFrame → ch1 (agent)
     */
    _interleave(leftFrame, rightFrame) {
        const out  = Buffer.allocUnsafe(STEREO_FRAME_BYTES);
        // Int16Array typed access is significantly faster than readInt16LE/writeInt16LE
        // because it avoids the per-call bounds-check overhead of the Buffer API.
        const L    = new Int16Array(leftFrame.buffer,  leftFrame.byteOffset,  FRAME_SIZE);
        const R    = new Int16Array(rightFrame.buffer, rightFrame.byteOffset, FRAME_SIZE);
        const view = new Int16Array(out.buffer, out.byteOffset, FRAME_SIZE * 2);
        for (let i = 0; i < FRAME_SIZE; i++) {
            view[i * 2]     = L[i]; // customer (L)
            view[i * 2 + 1] = R[i]; // agent    (R)
        }
        return out;
    }
}
