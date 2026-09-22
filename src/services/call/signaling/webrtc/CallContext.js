// services/call/CallContext.js
// Shared call business metadata — one instance per call, referenced by all
// WebRTCConnection objects that belong to that call.
import { CallDirection } from '../../constants/CallConstants.js';

export class CallContext {
    constructor(callId) {
        if (!callId) throw new Error('CallContext requires callId');
        this.callId     = callId;
        this.wacid      = null;
        this.userId     = null;
        this.businessId = null;
        this.direction  = null;
        this.caller     = { id: null, name: null, number: null };
        this.callee     = { id: null, name: null, number: null, bsuid: null, username: null };
        this.meta       = {};
        // undefined = not yet fetched; null = fetched, no IVR menu.
        // PeerRegistry.checkAndStartBridging caches the first DB result here
        // so subsequent connection-ready events skip the round-trip on non-IVR calls.
        this.ivrMenuId  = undefined;
    }

    /** In-memory only — the DB write happens explicitly in the call site. */
    setWacid(wacid) {
        this.wacid = wacid ?? null;
    }

    update(data = {}) {
        if (data.direction && !Object.values(CallDirection).includes(data.direction)) {
            throw new Error(`Invalid direction: ${data.direction}`);
        }
        Object.assign(this, {
            ...data,
            caller: { ...this.caller, ...(data.caller || {}) },
            callee: { ...this.callee, ...(data.callee || {}) },
            meta:   { ...this.meta,   ...(data.meta   || {}) },
        });
    }
}
