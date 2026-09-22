// services/call/AudioTrackState.js
// Per-connection audio placeholder queue, real-track flag, and track buffer.
// Extracted from ConnectionData to give audio state its own focused class.
import { placeholderTrackFactory } from '../../audio/PlaceholderTrackFactory.js';

export class AudioTrackState {
    constructor() {
        this.hasRealTrack       = false;
        this.placeholderSenders = [];
        this.trackBuffer        = [];
    }

    setHasRealTrack(value) {
        this.hasRealTrack = Boolean(value);
    }

    addPlaceholderSender(sender) {
        this.placeholderSenders.push(sender);
    }

    /**
     * Return the first queued placeholder sender without removing it,
     * or null if none are available.
     */
    getActivePlaceholderSender() {
        return this.placeholderSenders[0] ?? null;
    }

    /**
     * Remove and return the first placeholder sender, stopping its
     * audio-generation interval if the underlying track has one.
     */
    shiftPlaceholderSender() {
        const sender = this.placeholderSenders.shift();
        if (sender) {
            // Release the original generated placeholder track. After replaceTrack()
            // sender.track may already be the real/monitor track, so prefer the stable
            // _placeholderTrack reference set when the placeholder was added.
            placeholderTrackFactory.releaseGeneratedTrack(sender._placeholderTrack ?? sender.track);
            sender._placeholderTrack = null;
        }
        return sender ?? null;
    }

    /** Stop all placeholder audio intervals and empty the sender list. */
    clearPlaceholderSenders() {
        for (const sender of this.placeholderSenders) {
            // TEARDOWN path: Peer.cleanup() has already closed the owning pc before
            // calling this, so it is safe to fully stop the generated track and free
            // its native RTCAudioSource (no live sender to disrupt). Use the stable
            // _placeholderTrack ref — sender.track may have been swapped by replaceTrack().
            placeholderTrackFactory.releaseGeneratedTrack(
                sender?._placeholderTrack ?? sender?.track,
                { stopTrack: true },
            );
            if (sender) sender._placeholderTrack = null;
        }
        this.placeholderSenders = [];
    }

    clearTrackBuffer() {
        this.trackBuffer = [];
    }
}
