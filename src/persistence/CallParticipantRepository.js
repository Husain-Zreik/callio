// src/persistence/CallParticipantRepository.js
// call_participants: who is in a call, and when they joined and left.
import connection from '../../config/dbConnection.js';

class CallParticipantRepository {
    // Opens a row unless this participant already has an open one, so a
    // repeated join (a retried event, a reconnect) never duplicates them.
    // Returns true if a row was opened.
    async join({ callId, tenantId, kind, agentId = null, deviceId = null, mediaNode = null, at = new Date() }) {
        const [r] = await connection.execute(
            `INSERT INTO call_participants (call_id, tenant_id, kind, agent_id, device_id, media_node, joined_at, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, NOW(), NOW() FROM DUAL
             WHERE NOT EXISTS (
                 SELECT 1 FROM call_participants
                 WHERE call_id = ? AND kind = ? AND agent_id <=> ? AND left_at IS NULL
             )`,
            [callId, tenantId, kind, agentId, deviceId, mediaNode, at, callId, kind, agentId]
        );
        return r.affectedRows > 0;
    }

    // Closes this participant's open row. Returns true if one was open.
    async leave({ callId, kind, agentId = null, reason, at = new Date() }) {
        const [r] = await connection.execute(
            `UPDATE call_participants SET left_at = ?, leave_reason = ?, updated_at = NOW()
             WHERE call_id = ? AND kind = ? AND agent_id <=> ? AND left_at IS NULL`,
            [at, reason, callId, kind, agentId]
        );
        return r.affectedRows > 0;
    }

    // Closes every open row of the call (it ended).
    async leaveAll(callId, reason, at = new Date()) {
        const [r] = await connection.execute(
            `UPDATE call_participants SET left_at = ?, leave_reason = ?, updated_at = NOW()
             WHERE call_id = ? AND left_at IS NULL`,
            [at, reason, callId]
        );
        return r.affectedRows;
    }

    async setDevice({ callId, kind, agentId, deviceId }) {
        await connection.execute(
            `UPDATE call_participants SET device_id = ?, updated_at = NOW()
             WHERE call_id = ? AND kind = ? AND agent_id <=> ? AND left_at IS NULL`,
            [deviceId, callId, kind, agentId]
        );
    }

    async findByCall(callId) {
        const [rows] = await connection.execute(
            `SELECT p.*, a.external_ref AS agent_ref, a.name AS agent_name
             FROM call_participants p LEFT JOIN agents a ON a.id = p.agent_id
             WHERE p.call_id = ? ORDER BY p.joined_at, p.id`,
            [callId]
        );
        return rows;
    }
}

export default new CallParticipantRepository();
