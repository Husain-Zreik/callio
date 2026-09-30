// src/core/calls/CallNotifications.js
// The port the core uses to tell agents' devices (push) that a ringing call
// was resolved — answered or declined — so other devices stop ringing.
// push/ registers the implementation (CallPushNotifier) at startup; without
// one (CLI scripts) nothing is sent.
class CallNotifications {
    constructor() {
        this._impl = null;
    }

    register(impl) {
        this._impl = impl;
    }

    async notifyCallResolved(callId, options) {
        if (this._impl) await this._impl.notifyCallResolved(callId, options);
    }
}

export const callNotifications = new CallNotifications();
