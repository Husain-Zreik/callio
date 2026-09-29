// src/core/ivr/IvrTerminationHandler.js
// Ends a call whose IVR flow finished without transferring it (hang-up node,
// timeout, error, or the caller hanging up mid-flow): tells the provider,
// finalizes the row, closes media, releases any agent. Registered once per
// worker; the realtime layer only relays the IVR events to supervisors.
import EventBus from '../EventBus.js';
import { callTerminator } from '../calls/CallTerminator.js';
import { TerminationReason, TerminatedBy } from '../constants/CallConstants.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.ivr.IvrTerminationHandler');

export function ivrTerminationReason(action) {
    switch (String(action || '').toLowerCase()) {
        case 'timeout': return TerminationReason.TIMEOUT;
        case 'error': return TerminationReason.SYSTEM_ERROR;
        default: return TerminationReason.COMPLETED;
    }
}

class IvrTerminationHandler {
    constructor() {
        this._registered = false;
    }

    register() {
        if (this._registered) return;
        this._registered = true;
        EventBus.on('call:ivr_terminated', (data) => this.#handle(data));
    }

    async #handle({ callId, action }) {
        const terminationReason = ivrTerminationReason(action);
        log.info({ callId }, `IVR ended the call — action=${action}, reason=${terminationReason}`);
        try {
            await callTerminator.end(callId, {
                reason: terminationReason,
                terminatedBy: TerminatedBy.SYSTEM,
                provider: 'terminate',
                source: 'ivr',
            });
        } catch (err) {
            log.error({ callId, err }, 'Failed to end call');
        }
    }
}

export const ivrTerminationHandler = new IvrTerminationHandler();
