// src/media/recording/RecordingManager.js
import { RecordingSession } from './RecordingSession.js';
import { audioCaptureService } from './AudioCaptureService.js';
import { placeholderTrackFactory } from '../bridge/PlaceholderTrackFactory.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('media.recording.RecordingManager');

class RecordingManager {
    constructor() {
        this.activeSessions = new Map(); // callId -> RecordingSession
    }

    async startRecording(callId, tenantId, tracks) {
        if (this.activeSessions.has(callId)) {
            log.warn({ callId }, 'Call is already being recorded');
            return { success: false, reason: 'Already recording' };
        }

        const { agentTrack, customerTrack } = tracks;

        if (!agentTrack || !customerTrack) {
            log.warn({ callId }, 'Missing tracks');
            return { success: false, reason: 'Missing audio tracks' };
        }

        try {
            log.info({ callId }, 'Starting recording');

            const session = new RecordingSession(callId, tenantId);
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

            log.info({ callId }, 'Recording started');
            return { success: true, recordingId: session.recordingId };

        } catch (error) {
            log.error({ callId, err: error }, 'Failed to start recording');
            audioCaptureService.stopAllCaptures(callId);
            this.activeSessions.delete(callId);
            return { success: false, reason: error.message };
        }
    }

    async stopRecording(callId) {
        const session = this.activeSessions.get(callId);

        if (!session) {
            log.debug({ callId }, 'No active recording — nothing to stop');
            return { success: false, reason: 'Not recording' };
        }

        try {
            log.info({ callId }, 'Stopping recording');

            // Clear any active placeholder interval
            placeholderTrackFactory.clearTrack(callId);

            audioCaptureService.stopAllCaptures(callId);

            const stopped = await session.stop();
            session.cleanup();
            this.activeSessions.delete(callId);

            if (!stopped) {
                return { success: false, reason: 'Failed to stop recording session' };
            }

            log.info({ callId }, 'Recording stopped');

            return { success: true, recordingId: session.recordingId };

        } catch (error) {
            log.error({ callId, err: error }, 'Failed to stop recording');
            return { success: false, reason: error.message };
        }
    }

    /**
     * Pause agent track capture when AGENT disconnects.
     * Session and customer track remain active.
     */
    pauseAgentCapture(callId) {
        if (!this.activeSessions.has(callId)) return;
        audioCaptureService.stopCapture(callId, 'agent');
        // Tell the worker's mix buffer to fill the agent channel with silence while paused
        this.activeSessions.get(callId).setTrackActive('agent', false);
        log.info({ callId }, 'Agent capture paused — customer continues');
    }

    /**
     * Replace the agent track on reconnect/transfer.
     * Clears the placeholder interval and wires the new live track.
     */
    replaceAgentTrack(callId, newAgentTrack) {
        const session = this.activeSessions.get(callId);

        if (!session) {
            log.warn({ callId }, 'replaceAgentTrack: no active session');
            return false;
        }

        if (!newAgentTrack || newAgentTrack.readyState !== 'live') {
            log.error({ callId }, 'replaceAgentTrack: new agent track is not live');
            return false;
        }

        try {
            // Stop placeholder interval — it was writing PCM directly to the session
            placeholderTrackFactory.clearTrack(callId);

            // Stop any lingering agent sink
            audioCaptureService.stopCapture(callId, 'agent');
            log.debug({ callId }, 'Old agent track capture stopped');

            // Re-enable agent channel in the worker's mix buffer and reset encoder state
            session.setTrackActive('agent', true);
            session.resetAgentEncoder();

            const started = audioCaptureService.startCapture(
                callId, newAgentTrack, 'agent',
                (audioData, trackType) => session.writeAudioData(audioData, trackType)
            );

            if (!started) {
                log.error({ callId }, 'Failed to start capture on new agent track');
                return false;
            }

            log.debug({ callId }, 'Agent track replaced — recording continues');
            return true;

        } catch (error) {
            log.error({ callId, err: error }, 'replaceAgentTrack failed');
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
        log.info(`Cleaning up ${this.activeSessions.size} active recordings...`);
        await Promise.allSettled([...this.activeSessions.keys()].map(id => this.stopRecording(id)));
        audioCaptureService.cleanup();
        log.info('Cleanup complete');
    }
}

export const recordingManager = new RecordingManager();
