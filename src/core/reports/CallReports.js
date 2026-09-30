// src/core/reports/CallReports.js
// Contact-center reports for one tenant (docs/management-api.md, Reports).
//
// Definitions (inbound):
//   answered    an agent accepted it (first inbound_accepted) — an IVR picking
//               up doesn't count
//   abandoned   ended unanswered by the customer hanging up
//   missed      ended unanswered for any other reason (ring/queue timeout,
//               rejected, failure)
//   wait        from entering the queue (queued_at) to an agent answering
//   service level  answered within N seconds of entering the queue, over the
//               calls that entered a queue and are over or answered
// Talk time is call_duration (customer ⇄ agent), for answered inbound and
// connected outbound calls.
import ReportRepository from '../../persistence/ReportRepository.js';
import { CallStatus, CallDirection, TerminatedBy, AgentAvailability } from '../constants/CallConstants.js';

const ENDED = new Set([CallStatus.TERMINATED, CallStatus.FAILED]);
const secondsBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000));
const avg = (sum, n) => (n ? Math.round(sum / n) : null);

function emptyBucket() {
    return {
        inbound: 0, answered: 0, abandoned: 0, missed: 0, inProgress: 0,
        outbound: 0, outboundConnected: 0,
        serviceLevel: { within: 0, of: 0 }, wait: { sum: 0, n: 0, max: 0 }, talk: { sum: 0, n: 0 },
    };
}

function add(b, call, slSeconds) {
    const ended = ENDED.has(call.status);
    if (call.direction === CallDirection.OUTBOUND) {
        b.outbound++;
        if (call.answered_at) {
            b.outboundConnected++;
            if (ended) { b.talk.sum += call.call_duration || 0; b.talk.n++; }
        }
        return;
    }
    b.inbound++;
    const answeredAt = call.agent_answered_at;
    if (answeredAt) {
        b.answered++;
        if (ended) { b.talk.sum += call.call_duration || 0; b.talk.n++; }
        if (call.queued_at) {
            const wait = secondsBetween(call.queued_at, answeredAt);
            b.wait.sum += wait; b.wait.n++; b.wait.max = Math.max(b.wait.max, wait);
        }
    } else if (!ended) {
        b.inProgress++;
    } else if (call.terminated_by === TerminatedBy.CUSTOMER) {
        b.abandoned++;
    } else {
        b.missed++;
    }
    if (call.queued_at && (answeredAt || ended)) {
        b.serviceLevel.of++;
        if (answeredAt && secondsBetween(call.queued_at, answeredAt) <= slSeconds) b.serviceLevel.within++;
    }
}

function view(b) {
    return {
        inbound: b.inbound, answered: b.answered, abandoned: b.abandoned, missed: b.missed, inProgress: b.inProgress,
        outbound: b.outbound, outboundConnected: b.outboundConnected,
        serviceLevelPercent: b.serviceLevel.of ? Math.round((1000 * b.serviceLevel.within) / b.serviceLevel.of) / 10 : null,
        avgWaitSeconds: avg(b.wait.sum, b.wait.n),
        maxWaitSeconds: b.wait.n ? b.wait.max : null,
        talkSeconds: b.talk.sum,
        avgTalkSeconds: avg(b.talk.sum, b.talk.n),
    };
}

class CallReports {
    /**
     * @param {Date} from, to        the window (calls created in it)
     * @param {'hour'|'day'} interval
     * @param {number} utcOffsetMinutes  bucket boundaries in this fixed offset (no DST)
     */
    async calls(tenantId, { from, to, interval, utcOffsetMinutes = 0, serviceLevelSeconds = 20, queueId = null, channelId = null }) {
        const rows = await ReportRepository.callsInRange(tenantId, from, to, { queueId, channelId });
        const step = interval === 'hour' ? 3600_000 : 86_400_000;
        const offset = utcOffsetMinutes * 60_000;
        const bucketStart = (t) => Math.floor((new Date(t).getTime() + offset) / step) * step - offset;

        const buckets = new Map();
        for (let t = bucketStart(from); t < to.getTime(); t += step) buckets.set(t, emptyBucket());
        const totals = emptyBucket();
        for (const call of rows) {
            add(totals, call, serviceLevelSeconds);
            const b = buckets.get(bucketStart(call.created_at));
            if (b) add(b, call, serviceLevelSeconds);
        }
        return {
            totals: view(totals),
            buckets: [...buckets.entries()].map(([t, b]) => ({ start: new Date(t).toISOString(), ...view(b) })),
        };
    }

    async agents(tenantId, { from, to }) {
        const [agents, counts, talk] = await Promise.all([
            ReportRepository.agents(tenantId),
            ReportRepository.agentEventCounts(tenantId, from, to),
            ReportRepository.agentTalkTime(tenantId, from, to),
        ]);
        const by = new Map();
        const row = (agentId) => {
            const key = String(agentId);
            if (!by.has(key)) by.set(key, { answered: 0, transfersReceived: 0, declined: 0, missed: 0, outbound: 0, outboundConnected: 0, talkSeconds: 0, talkCalls: 0 });
            return by.get(key);
        };
        const field = {
            inbound_accepted: 'answered', inbound_follow_up: 'transfersReceived', inbound_rejected: 'declined',
            inbound_offer_missed: 'missed', ivr_agent_missed: 'missed', outbound_initiated: 'outbound', outbound_accepted: 'outboundConnected',
        };
        for (const c of counts) row(c.agent_id)[field[c.event_type]] += Number(c.n);
        for (const t of talk) { const r = row(t.agent_id); r.talkSeconds = Number(t.seconds) || 0; r.talkCalls = Number(t.calls); }

        return agents
            .filter((a) => !a.deleted_at || by.has(String(a.id)))
            .map((a) => {
                const r = by.get(String(a.id)) ?? row(a.id);
                const { talkCalls, ...rest } = r;
                return {
                    agentRef: a.external_ref, name: a.name, role: a.role, availability: a.deleted_at ? null : a.availability,
                    ...rest, avgTalkSeconds: avg(r.talkSeconds, talkCalls),
                };
            });
    }

    async live(tenantId) {
        const { queues, members, totals } = await ReportRepository.liveQueues(tenantId);
        const now = Date.now();
        return {
            liveCalls: Number(totals?.live ?? 0),
            inIvr: Number(totals?.in_ivr ?? 0),
            queues: queues.map((q) => {
                const agents = { available: 0, onCall: 0, offline: 0 };
                for (const m of members.filter((x) => String(x.queue_id) === String(q.id))) {
                    if (m.availability === AgentAvailability.AVAILABLE) agents.available += Number(m.n);
                    else if (m.availability === AgentAvailability.ON_CALL) agents.onCall += Number(m.n);
                    else agents.offline += Number(m.n);
                }
                return {
                    queueRef: q.external_ref, name: q.name,
                    waiting: Number(q.waiting), onCall: Number(q.on_call),
                    longestWaitSeconds: q.oldest_waiting_since ? secondsBetween(q.oldest_waiting_since, now) : null,
                    agents,
                };
            }),
        };
    }
}

export const callReports = new CallReports();
