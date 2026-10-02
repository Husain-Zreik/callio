// src/persistence/ReportRepository.js
// Read-only queries behind the Management API reports (core/reports).
// Every query is scoped to one tenant.
import connection from '../../config/dbConnection.js';
import { reportedAvailability } from './AgentRepository.js';

const LIVE = "('INITIATED', 'RINGING', 'IN_PROGRESS')";

class ReportRepository {
    // The tenant's calls created in [from, to), with the moment an agent first
    // answered (an IVR call's answered_at is when the IVR picked up, not an agent).
    async callsInRange(tenantId, from, to, { queueId = null, channelId = null } = {}) {
        const params = [tenantId, from, to];
        let extra = '';
        if (queueId != null) { extra += ' AND c.queue_id = ?'; params.push(queueId); }
        if (channelId != null) { extra += ' AND c.channel_id = ?'; params.push(channelId); }
        const [rows] = await connection.execute(
            `SELECT c.id, c.direction, c.status, c.terminated_by, c.created_at, c.queued_at, c.answered_at, c.call_duration,
                    (SELECT MIN(e.occurred_at) FROM call_lifecycle_events e
                      WHERE e.call_id = c.id AND e.event_type = 'inbound_accepted') AS agent_answered_at
             FROM calls c
             WHERE c.tenant_id = ? AND c.created_at >= ? AND c.created_at < ? ${extra}`,
            params
        );
        return rows;
    }

    // Per agent and event type, counted over lifecycle events in [from, to).
    async agentEventCounts(tenantId, from, to) {
        const [rows] = await connection.execute(
            `SELECT e.agent_id, e.event_type, COUNT(*) AS n
             FROM call_lifecycle_events e
             WHERE e.tenant_id = ? AND e.occurred_at >= ? AND e.occurred_at < ? AND e.agent_id IS NOT NULL
               AND e.event_type IN ('inbound_accepted', 'inbound_follow_up', 'inbound_rejected', 'inbound_offer_missed',
                                    'ivr_agent_missed', 'outbound_initiated', 'outbound_accepted')
             GROUP BY e.agent_id, e.event_type`,
            [tenantId, from, to]
        );
        return rows;
    }

    // Talk time per agent: calls that ended in [from, to), credited to the
    // agent the call ended with.
    async agentTalkTime(tenantId, from, to) {
        const [rows] = await connection.execute(
            `SELECT agent_id, COUNT(*) AS calls, SUM(call_duration) AS seconds
             FROM calls
             WHERE tenant_id = ? AND ended_at >= ? AND ended_at < ? AND agent_id IS NOT NULL AND call_duration > 0
             GROUP BY agent_id`,
            [tenantId, from, to]
        );
        return rows;
    }

    async agents(tenantId) {
        const [rows] = await connection.execute(
            `SELECT id, external_ref, name, role, ${reportedAvailability()} AS availability, deleted_at FROM agents WHERE tenant_id = ?`,
            [tenantId]
        );
        return rows;
    }

    // Right now, per queue: calls waiting for an agent (not in the IVR, not
    // answered) and since when; members by availability.
    async liveQueues(tenantId) {
        const [queues] = await connection.execute(
            `SELECT q.id, q.external_ref, q.name,
                    (SELECT COUNT(*) FROM calls c WHERE c.queue_id = q.id AND c.status = 'RINGING'
                       AND (c.state IS NULL OR c.state = 'QUEUE')) AS waiting,
                    (SELECT MIN(COALESCE(c.queued_at, c.ringing_at)) FROM calls c WHERE c.queue_id = q.id AND c.status = 'RINGING'
                       AND (c.state IS NULL OR c.state = 'QUEUE')) AS oldest_waiting_since,
                    (SELECT COUNT(*) FROM calls c WHERE c.queue_id = q.id AND c.status = 'IN_PROGRESS'
                       AND (c.state IS NULL OR c.state <> 'IVR')) AS on_call
             FROM queues q WHERE q.tenant_id = ? ORDER BY q.id`,
            [tenantId]
        );
        const [members] = await connection.execute(
            `SELECT m.queue_id, ${reportedAvailability('a')} AS availability, COUNT(*) AS n
             FROM queue_members m JOIN agents a ON a.id = m.agent_id
             JOIN queues q ON q.id = m.queue_id
             WHERE q.tenant_id = ? AND a.deleted_at IS NULL
             GROUP BY m.queue_id, 2`,
            [tenantId]
        );
        const [[totals]] = await connection.execute(
            `SELECT COUNT(*) AS live, SUM(state = 'IVR') AS in_ivr
             FROM calls WHERE tenant_id = ? AND status IN ${LIVE}`,
            [tenantId]
        );
        return { queues, members, totals };
    }
}

export default new ReportRepository();
