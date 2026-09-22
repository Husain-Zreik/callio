// src/services/call/audio/recording/RecordingManager.js
import { RecordingSession } from './RecordingSession.js';
import { audioCaptureService } from './AudioCaptureService.js';
import { placeholderTrackFactory } from '../PlaceholderTrackFactory.js';

class RecordingManager {
    constructor() {
        this.activeSessions = new Map(); // callId -> RecordingSession
    }

    async startRecording(callId, businessId, tracks) {
        if (this.activeSessions.has(callId)) {
            console.warn(`[RecordingManager] Call ${callId} is already being recorded`);
            return { success: false, reason: 'Already recording' };
        }

        const { agentTrack, customerTrack } = tracks;

        if (!agentTrack || !customerTrack) {
            console.error(`[RecordingManager] Missing tracks for call ${callId}`);
            return { success: false, reason: 'Missing audio tracks' };
        }

        try {
            console.log(`[RecordingManager] Starting recording for call ${callId}`);

            const session = new RecordingSession(callId, businessId);
            this.activeSessions.set(callId, session);

            const started = await session.start();
            if (!started) {
                this.activeSessions.delete(callId);
                return { success: false, reason: 'Failed to initialize recording session' };
            }

            const agentCaptureStarted = audioCaptureService.startCapture(
                callId, agentTrack, 'agent',
                (audioData, trackType) => session.writeAudioData(audioData, trackType)
            );

            if (!agentCaptureStarted) {
                await session.abort();
                this.activeSessions.delete(callId);
                return { success: false, reason: 'Failed to capture agent audio' };
            }

            const customerCaptureStarted = audioCaptureService.startCapture(
                callId, customerTrack, 'customer',
                (audioData, trackType) => session.writeAudioData(audioData, trackType)
            );

            if (!customerCaptureStarted) {
                audioCaptureService.stopCapture(callId, 'agent');
                await session.abort();
                this.activeSessions.delete(callId);
                return { success: false, reason: 'Failed to capture customer audio' };
            }

            console.log(`[RecordingManager] ✅ Recording started for call ${callId}`);
            return { success: true, recordingId: session.recordingId };

        } catch (error) {
            console.error(`[RecordingManager] ❌ Failed to start recording for call ${callId}:`, error.message);
            audioCaptureService.stopAllCaptures(callId);
            this.activeSessions.delete(callId);
            return { success: false, reason: error.message };
        }
    }

    async stopRecording(callId) {
        const session = this.activeSessions.get(callId);

        if (!session) {
            console.log(`[RecordingManager] No active recording for call ${callId} — nothing to stop`);
            return { success: false, reason: 'Not recording' };
        }

        try {
            console.log(`[RecordingManager] Stopping recording for call ${callId}`);

            // Clear any active placeholder interval
            placeholderTrackFactory.clearTrack(callId);

            audioCaptureService.stopAllCaptures(callId);

            const stopped = await session.stop();
            session.cleanup();
            this.activeSessions.delete(callId);

            if (!stopped) {
                return { success: false, reason: 'Failed to stop recording session' };
            }

            console.log(`[RecordingManager] ✅ Recording stopped for call ${callId}`);

            return { success: true, recordingId: session.recordingId };

        } catch (error) {
            console.error(`[RecordingManager] ❌ Failed to stop recording for call ${callId}:`, error.message);
            return { success: false, reason: error.message };
        }
    }

    /**
     * Pause agent track capture when FRONTEND disconnects.
     * Session and customer track remain active.
     */
    pauseAgentCapture(callId) {
        if (!this.activeSessions.has(callId)) return;
        audioCaptureService.stopCapture(callId, 'agent');
        // Tell the worker's mix buffer to fill the agent channel with silence while paused
        this.activeSessions.get(callId).setTrackActive('agent', false);
        console.log(`[RecordingManager] ⏸️ Agent capture paused for call ${callId} — customer continues`);
    }

    /**
     * Replace the agent track on reconnect/transfer.
     * Clears the placeholder interval and wires the new live track.
     */
    replaceAgentTrack(callId, newAgentTrack) {
        const session = this.activeSessions.get(callId);

        if (!session) {
            console.warn(`[RecordingManager] replaceAgentTrack: no active session for call ${callId}`);
            return false;
        }

        if (!newAgentTrack || newAgentTrack.readyState !== 'live') {
            console.error(`[RecordingManager] replaceAgentTrack: new agent track is not live for call ${callId}`);
            return false;
        }

        try {
            // Stop placeholder interval — it was writing PCM directly to the session
            placeholderTrackFactory.clearTrack(callId);

            // Stop any lingering agent sink
            audioCaptureService.stopCapture(callId, 'agent');
            console.log(`[RecordingManager] 🔄 Old agent track capture stopped for call ${callId}`);

            // Re-enable agent channel in the worker's mix buffer and reset encoder state
            session.setTrackActive('agent', true);
            session.resetAgentEncoder();

            const started = audioCaptureService.startCapture(
                callId, newAgentTrack, 'agent',
                (audioData, trackType) => session.writeAudioData(audioData, trackType)
            );

            if (!started) {
                console.error(`[RecordingManager] ❌ Failed to start capture on new agent track for call ${callId}`);
                return false;
            }

            console.log(`[RecordingManager] ✅ Agent track replaced for call ${callId} — recording continues`);
            return true;

        } catch (error) {
            console.error(`[RecordingManager] ❌ replaceAgentTrack failed for call ${callId}:`, error.message);
            return false;
        }
    }

    /**
     * Get the active session for a call (used by AudioCoordinator to build onFrame callback).
     */
    getSession(callId) {
        return this.activeSessions.get(callId) || null;
    }

    isRecording(callId) {
        return this.activeSessions.has(callId);
    }

    async cleanup() {
        console.log(`[RecordingManager] Cleaning up ${this.activeSessions.size} active recordings...`);
        await Promise.allSettled([...this.activeSessions.keys()].map(id => this.stopRecording(id)));
        audioCaptureService.cleanup();
        console.log('[RecordingManager] ✅ Cleanup complete');
    }
}

export const recordingManager = new RecordingManager();
