// services/call/audio/dtmf/DTMFCoordinator.js
//
// Stable public API for DTMF teardown used by AudioCoordinator.
// IvrCoordinator drives start/pause/resume/stop on dtmfCaptureService directly.
//
// No DB access, no business logic.
import { dtmfCaptureService } from './DTMFCaptureService.js';

class DTMFCoordinator {

    // ─────────────────────────────────────────────────────────────────
    // TEARDOWN
    // ─────────────────────────────────────────────────────────────────

    /**
     * Hard-release the DTMF sink at final call teardown (frees the native buffer).
     * Call only after the owning peer connection is closed — safe because
     * the customer track is already ending at that point.
     */
    destroyDetection(callId) {
        dtmfCaptureService.destroy(callId);
    }

    cleanup() {
        dtmfCaptureService.cleanup();
    }
}

export const dtmfCoordinator = new DTMFCoordinator();
