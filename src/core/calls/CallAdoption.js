// src/core/calls/CallAdoption.js
// A call outlives the worker that ran it (docs/media-architecture.md, "Call
// ownership and inputs"): its media keeps going on rtpengine and FreeSWITCH,
// its inputs wait in its inbox, its timers in Redis. Every worker checks for
// live calls whose lease lapsed (callInbox.orphans) and takes one over: it
// claims the lease (one worker wins), rebuilds the call's room from the stored
// snapshot (callMedia.adopt), then handles its inbox from where the dead
// worker stopped. A call that ended meanwhile is just forgotten.
import CallRepository from '../../persistence/CallRepository.js';
import { callMedia } from '../media/CallMedia.js';
import { customerChannels } from '../channels/CustomerChannels.js';
import { callInbox } from '../../infra/cluster/CallInbox.js';
import { callState } from '../../infra/cluster/CallState.js';
import { callEventHandler } from '../events/CallEventHandler.js';
import { ivrCoordinator } from '../ivr/IvrCoordinator.js';
import { CallStatus } from '../constants/CallConstants.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.calls.CallAdoption');

const TICK_MS = 2000;

class CallAdoption {
    constructor() {
        this._timer = null;
        this._running = false;
    }

    start() {
        if (this._timer) return;
        this._timer = setInterval(() => this._tick(), TICK_MS);
        this._timer.unref();
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
    }

    async _tick() {
        if (this._running) return;
        this._running = true;
        try {
            for (const callId of await callInbox.orphans()) {
                await this._take(callId).catch((err) => log.error({ callId, err }, 'Taking a call over failed'));
            }
        } catch (err) {
            log.warn({ err }, 'Checking for calls to take over failed');
        } finally {
            this._running = false;
        }
    }

    async _take(id) {
        const callId = Number(id);   // ids come back from Redis as strings; the core uses numbers
        const call = await CallRepository.findById(callId);
        if (!call || call.status === CallStatus.TERMINATED || call.status === CallStatus.FAILED) {
            await callInbox.forget(callId);
            await callState.dropAll(callId);
            return;
        }
        if (!(await callInbox.claim(callId))) return;   // another worker got it
        let adopted;
        try {
            adopted = await callMedia.adopt(call);
        } catch (err) {
            await callInbox.release(callId);   // a later check tries again
            throw err;
        }
        if (!adopted) {
            // No room to take over (its media never came up): the stuck-call
            // scan ends it; nobody needs to own it.
            await callInbox.release(callId);
            await callInbox.forget(callId);
            return;
        }
        // A worker that died between answering and bridging left the call
        // half set up; bridge() does what's missing (it's a no-op otherwise).
        if (call.status === CallStatus.IN_PROGRESS) {
            await callMedia.bridge(call).catch((err) => log.warn({ callId, err }, 'Finishing the bridge failed'));
        }
        // A caller in the IVR continues at the node they were on.
        const ivr = await callState.load(callId, 'ivr');
        if (ivr?.flowId && ivr.nodeId) {
            ivrCoordinator.startSession(callId, ivr.flowId, {
                tenantId: call.tenant_id, channelId: call.channel_id, queueId: call.queue_id ?? null,
            }, { resume: { sessionId: ivr.sessionId, nodeId: ivr.nodeId } })
                .catch((err) => log.error({ callId, err }, 'Resuming the IVR failed'));
        }
        // The provider side, where it lives in a worker's memory (a SIP dialog).
        const { channel } = await customerChannels.forCall(call);
        await Promise.resolve(channel.adopt?.(call)).catch((err) => log.warn({ callId, err }, 'Taking the provider leg over failed'));
        await callInbox.read(callId, callEventHandler.handleCallEvent);
        log.info({ callId }, 'Call taken over from a worker that stopped');
    }
}

export const callAdoption = new CallAdoption();
