// src/core/calls/CustomerNetworkLossPolicy.js
// When the customer's audio stops (CustomerSilenceWatchdog → customer:media:state
// 'drop'), the call is given a grace period: at 15 s the agent is warned
// (call:network:terminating, relayed to the call room by realtime/), at 20 s
// the call ends as CUSTOMER_NETWORK_LOSS. Audio coming back ('active') or the
// call ending cancels both. Runs on the worker holding the call's media, where
// the watchdog fires; the end is published so the owner's TerminationEventHandler
// ends it like any other.
import EventBus from '../EventBus.js';
import CallRepository from '../../persistence/CallRepository.js';
import { callLifecycleLogger } from './CallLifecycleLogger.js';
import { callInbox } from '../../infra/cluster/CallInbox.js';
import { EventTypes } from '../events/EventTypes.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.calls.CustomerNetworkLossPolicy');

const WARN_AFTER_MS = 15_000;   // matches the agent UI's weak → lost transition
const END_AFTER_MS = 20_000;

class CustomerNetworkLossPolicy {
    constructor() {
        this._timers = new Map();   // callId → { warnTimer, terminateTimer }
    }

    register() {
        EventBus.on('customer:media:state', ({ callId, state }) => {
            this._onMediaState(callId, state).catch((err) => log.error({ callId, err }, 'customer:media:state handling failed'));
        });
        EventBus.on('call:terminated', ({ callId }) => this._cancel(callId));
    }

    _cancel(callId) {
        const key = String(callId);
        const timers = this._timers.get(key);
        if (!timers) return false;
        clearTimeout(timers.warnTimer);
        clearTimeout(timers.terminateTimer);
        this._timers.delete(key);
        return true;
    }

    async _onMediaState(callId, state) {
        const key = String(callId);
        const call = await CallRepository.findById(callId);
        if (!call?.tenant_id) return;   // already cleaned up
        const agentId = call.agent_id ?? null;

        if (state === 'drop') {
            // The timeline records each real drop / recovery (the watchdog fires
            // on transitions only, never per frame).
            await callLifecycleLogger.logCustomerNetworkDrop(callId, call.tenant_id, agentId, { detection_method: 'silence_watchdog' });
            this._cancel(callId);   // a previous drop that never recovered
            const warnTimer = setTimeout(() => EventBus.emit('call:network:terminating', { callId }), WARN_AFTER_MS);
            const terminateTimer = setTimeout(async () => {
                this._timers.delete(key);
                try {
                    await callInbox.post(callId, EventTypes.CALL_TERMINATED, { callId, reason: 'customer_network_loss' });
                } catch (err) {
                    log.error({ callId, err }, 'Failed to publish CALL_TERMINATED');
                }
            }, END_AFTER_MS);
            this._timers.set(key, { warnTimer, terminateTimer });
        } else if (state === 'active') {
            this._cancel(callId);
            await callLifecycleLogger.logCustomerNetworkReconnected(callId, call.tenant_id, agentId, { detection_method: 'silence_watchdog' });
        }
    }
}

export const customerNetworkLossPolicy = new CustomerNetworkLossPolicy();
