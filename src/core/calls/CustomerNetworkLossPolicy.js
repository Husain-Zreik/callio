// src/core/calls/CustomerNetworkLossPolicy.js
// When the customer's audio stops (media/rooms/CustomerLegMonitor → customer:media:state
// 'drop'), the call is given a grace period: at 15 s the agent is warned
// (call:network:terminating, relayed to the call room by realtime/), at 20 s
// the call ends as CUSTOMER_NETWORK_LOSS. Audio coming back ('active') or the
// call ending cancels both. The drop is seen on the worker holding the call's
// media; the two steps are stored deadlines (infra/cluster/Deadlines.js), so they
// still happen if that worker dies, and run on any worker: the warning goes to
// the call room, the end is posted to the call's inbox.
import EventBus from '../EventBus.js';
import CallRepository from '../../persistence/CallRepository.js';
import { callLifecycleLogger } from './CallLifecycleLogger.js';
import { callInbox } from '../../infra/cluster/CallInbox.js';
import { deadlines } from '../../infra/cluster/Deadlines.js';
import { EventTypes } from '../events/EventTypes.js';
import { CallStatus } from '../constants/CallConstants.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.calls.CustomerNetworkLossPolicy');

const WARN_AFTER_MS = 15_000;   // matches the agent UI's weak → lost transition
const END_AFTER_MS = 20_000;
const WARN = 'network-warn';
const END = 'network-end';

class CustomerNetworkLossPolicy {
    register() {
        EventBus.on('customer:media:state', ({ callId, state }) => {
            this._onMediaState(callId, state).catch((err) => log.error({ callId, err }, 'customer:media:state handling failed'));
        });
        EventBus.on('call:terminated', ({ callId }) => {
            this._cancel(callId).catch(() => { });
        });
        deadlines.on(WARN, (callId) => this._warn(callId));
        deadlines.on(END, (callId) => this._end(callId));
    }

    async _cancel(callId) {
        await Promise.all([deadlines.clear(WARN, callId), deadlines.clear(END, callId)]);
    }

    async _warn(callId) {
        const call = await CallRepository.findById(callId);
        if (call?.status !== CallStatus.IN_PROGRESS) return;
        EventBus.emit('call:network:terminating', { callId });
    }

    async _end(callId) {
        const call = await CallRepository.findById(callId);
        if (!call || call.status === CallStatus.TERMINATED || call.status === CallStatus.FAILED) return;
        await callInbox.post(callId, EventTypes.CALL_TERMINATED, { callId, reason: 'customer_network_loss' });
    }

    async _onMediaState(callId, state) {
        const call = await CallRepository.findById(callId);
        if (!call?.tenant_id) return;   // already cleaned up
        const agentId = call.agent_id ?? null;

        if (state === 'drop') {
            // The timeline records each real drop / recovery (the watchdog fires
            // on transitions only, never per frame).
            await callLifecycleLogger.logCustomerNetworkDrop(callId, call.tenant_id, agentId, { detection_method: 'silence_watchdog' });
            // A previous drop that never recovered is replaced.
            await Promise.all([deadlines.set(WARN, callId, WARN_AFTER_MS), deadlines.set(END, callId, END_AFTER_MS)]);
        } else if (state === 'active') {
            await this._cancel(callId);
            await callLifecycleLogger.logCustomerNetworkReconnected(callId, call.tenant_id, agentId, { detection_method: 'silence_watchdog' });
        }
    }
}

export const customerNetworkLossPolicy = new CustomerNetworkLossPolicy();
