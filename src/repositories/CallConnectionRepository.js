// src/repositories/CallConnectionRepository.js
import connection from '../../config/dbConnection.js';

class CallConnectionRepository {
    async create(data) {
        const {
            call_id,
            business_id = null,
            connection_type,
            media_types = ['audio'],
            local_sdp = null,
            remote_sdp = null,
            sdp_type = null,
        } = data;

        // Atomic upsert, not a plain INSERT: call_connections has a unique
        // index on (call_id, connection_type), and two concurrent callers can
        // race here (e.g. two overlapping AGENT_RECONNECTED events for the
        // same call). ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id) is the
        // standard MySQL idiom to make that race resolve to "hand back the
        // existing row's id" instead of a duplicate-key error or (before the
        // unique index existed) an actual duplicate row — and it touches only
        // `id`, so it can never clobber device_id/SDP fields a concurrent
        // caller may have already written on the existing row.
        const [result] = await connection.execute(`
            INSERT INTO call_connections (
                call_id, business_id, connection_type,
                media_types, local_sdp, remote_sdp, sdp_type,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
            ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)
        `, [
            call_id, business_id, connection_type,
            JSON.stringify(media_types), local_sdp, remote_sdp, sdp_type
        ]);

        return { id: result.insertId };
    }

    // ── Queries ─────────────────────────────────────────────────────────────────

    async findByCallAndType(callId, connectionType) {
        const [rows] = await connection.execute(
            'SELECT * FROM call_connections WHERE call_id = ? AND connection_type = ?',
            [callId, connectionType]
        );
        return rows[0] || null;
    }

    // Batched form of findByCallAndType for resync endpoints that need this
    // per-call — avoids one query per call when listing many ongoing calls.
    async findByCallIdsAndType(callIds, connectionType) {
        if (callIds.length === 0) return [];
        const placeholders = callIds.map(() => '?').join(', ');
        const [rows] = await connection.execute(
            `SELECT * FROM call_connections WHERE call_id IN (${placeholders}) AND connection_type = ?`,
            [...callIds, connectionType]
        );
        return rows;
    }

    // ── Updates ─────────────────────────────────────────────────────────────────

    async updateSDP(callId, connectionType, localSdp = null, remoteSdp = null, sdpType = null) {
        const updates = [];
        const params = [];

        if (localSdp !== null) {
            updates.push('local_sdp = ?');
            params.push(localSdp);
        }

        if (remoteSdp !== null) {
            updates.push('remote_sdp = ?');
            params.push(remoteSdp);
        }

        if (sdpType !== null) {
            updates.push('sdp_type = ?');
            params.push(sdpType);
        }

        if (updates.length === 0) return;

        updates.push('updated_at = NOW()');
        params.push(callId, connectionType);

        await connection.execute(
            `UPDATE call_connections SET ${updates.join(', ')} WHERE call_id = ? AND connection_type = ?`,
            params
        );
    }

    async updateConnectionState(callId, connectionType, connectionState, iceConnectionState = null) {
        const query = iceConnectionState
            ? 'UPDATE call_connections SET connection_state = ?, ice_connection_state = ?, updated_at = NOW() WHERE call_id = ? AND connection_type = ?'
            : 'UPDATE call_connections SET connection_state = ?, updated_at = NOW() WHERE call_id = ? AND connection_type = ?';

        const params = iceConnectionState
            ? [connectionState.toUpperCase(), iceConnectionState.toUpperCase(), callId, connectionType]
            : [connectionState.toUpperCase(), callId, connectionType];

        await connection.execute(query, params);
    }

    // Records which durable device (not the ephemeral socket.id) is bound to
    // this call's FRONTEND connection — read back by CallQueryService for the
    // ongoing-calls resync (a reloaded client needs this, since its own
    // in-memory state doesn't survive the reload) and by AgentEventHandler
    // before a reconnect takes over an already-bound call from another device.
    async updateDeviceId(callId, connectionType, deviceId) {
        await connection.execute(
            'UPDATE call_connections SET device_id = ?, updated_at = NOW() WHERE call_id = ? AND connection_type = ?',
            [deviceId, callId, connectionType]
        );
    }

    async markReady(callId, connectionType) {
        await connection.execute(`
            UPDATE call_connections
            SET connected_at = NOW(),
                updated_at = NOW()
            WHERE call_id = ? AND connection_type = ?
        `, [callId, connectionType]);
    }

    async addICECandidate(callId, connectionType, candidate) {
        const conn = await this.findByCallAndType(callId, connectionType);
        if (!conn) return false;

        let candidates = [];
        if (conn.ice_candidates) {
            try {
                candidates = typeof conn.ice_candidates === 'string'
                    ? JSON.parse(conn.ice_candidates)
                    : Array.isArray(conn.ice_candidates)
                        ? conn.ice_candidates
                        : [];
            } catch {
                candidates = [];
            }
        }

        const candidateObj = typeof candidate === 'object'
            ? {
                candidate: candidate.candidate,
                sdpMid: candidate.sdpMid,
                sdpMLineIndex: candidate.sdpMLineIndex,
                usernameFragment: candidate.usernameFragment
            }
            : JSON.parse(candidate);

        candidates.push(candidateObj);

        await connection.execute(`
            UPDATE call_connections
            SET ice_candidates = ?, ice_candidates_gathered = ?, updated_at = NOW()
            WHERE call_id = ? AND connection_type = ?
        `, [JSON.stringify(candidates), candidates.length, callId, connectionType]);

        return true;
    }

    async updateICEState(callId, connectionType, iceConnectionState) {
        await connection.execute(
            `UPDATE call_connections
                SET ice_connection_state = ?, updated_at = NOW()
                WHERE call_id = ? AND connection_type = ?`,
            [iceConnectionState.toUpperCase(), callId, connectionType]
        );
    }

    async updateICEGatheringState(callId, connectionType, iceGatheringState) {
        await connection.execute(
            `UPDATE call_connections
                SET ice_gathering_state = ?, updated_at = NOW()
                WHERE call_id = ? AND connection_type = ?`,
            [iceGatheringState.toUpperCase(), callId, connectionType]
        );
    }

    // ── Termination & Cleanup ────────────────────────────────────────────────────

    async terminateConnections(callId) {
        await connection.execute(`
            UPDATE call_connections
            SET connection_state = 'CLOSED',
                ice_connection_state = 'CLOSED',
                ice_gathering_state = 'COMPLETE',
                updated_at = NOW()
            WHERE call_id = ?
        `, [callId]);
    }

    async terminateConnection(connectionId, connectionType) {
        await connection.execute(`
            UPDATE call_connections
            SET connection_state = 'CLOSED',
                ice_connection_state = 'CLOSED',
                ice_gathering_state = 'COMPLETE',
                updated_at = NOW()
            WHERE id = ? AND connection_type = ?
        `, [connectionId, connectionType]);
    }

    async cleanupConnection(callId, connectionType) {
        await connection.execute(
            'DELETE FROM call_connections WHERE call_id = ? AND connection_type = ?',
            [callId, connectionType]
        );
    }

    async cleanup(callId) {
        await connection.execute(
            'DELETE FROM call_connections WHERE call_id = ?',
            [callId]
        );
    }
}

export default new CallConnectionRepository();
