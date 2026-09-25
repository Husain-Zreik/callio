// src/persistence/IvrRepository.js
// DB access for IVR flows, their audio, sessions and session inputs.
import connection from '../../config/dbConnection.js';

// Platform-wide default queue hold audio: an audio_assets row with no tenant
// and this external_ref.
const DEFAULT_HOLD_AUDIO_REF = 'default_hold';

function parseJson(value, fallback) {
    if (value == null) return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return fallback; }
}

// audio_assets rows are exposed in the { storage_key, storage_disk } shape the
// storage resolver takes.
function toStorageRef(row) {
    return row ? { id: row.id, storage_key: row.storage_key, storage_disk: row.storage_provider } : null;
}

class IvrRepository {
    // Lightweight flow fetch (id + name only) — for lifecycle log labels.
    async findFlowHeader(ivrFlowId, tenantId = null) {
        const [rows] = await connection.execute(
            `SELECT id, name FROM ivr_flows
             WHERE id = ? AND (? IS NULL OR tenant_id = ?)
             LIMIT 1`,
            [ivrFlowId, tenantId, tenantId]
        );
        return rows[0] ?? null;
    }

    // A flow with its structure and the audio its nodes reference.
    // Returns { id, name, status, timeout_seconds, structure, audioFilesById }.
    async findFlow(ivrFlowId, tenantId = null) {
        const [rows] = await connection.execute(
            `SELECT id, tenant_id, name, structure, timeout_seconds, status
             FROM ivr_flows
             WHERE id = ? AND (? IS NULL OR tenant_id = ?)
             LIMIT 1`,
            [ivrFlowId, tenantId, tenantId]
        );

        const flow = rows[0];
        if (!flow) return null;

        const structure = parseJson(flow.structure, { nodes: [], edges: [] });

        const audioIds = [];
        for (const node of (structure.nodes ?? [])) {
            const id = node.data?.audioFileId;
            if (id != null) audioIds.push(Number(id));
        }

        const audioFilesById = {};
        if (audioIds.length > 0) {
            const placeholders = audioIds.map(() => '?').join(',');
            const [audioRows] = await connection.execute(
                `SELECT id, storage_key, storage_provider
                 FROM audio_assets
                 WHERE id IN (${placeholders}) AND (tenant_id = ? OR tenant_id IS NULL)`,
                [...audioIds, flow.tenant_id]
            );
            for (const row of audioRows) audioFilesById[row.id] = toStorageRef(row);
        }

        return {
            id: flow.id,
            name: flow.name,
            status: flow.status,
            timeout_seconds: flow.timeout_seconds ?? 10,
            structure,
            audioFilesById,
        };
    }

    // Active flows that may take an inbound call on this channel: channel-specific
    // flows first, then tenant-wide ones, then trigger_priority, then most recent.
    async findCandidateFlows(tenantId, channelId) {
        const [rows] = await connection.execute(
            `SELECT id, channel_id, trigger_condition,
                    CASE WHEN channel_id = ? THEN 0 ELSE 1 END AS scope_order
             FROM ivr_flows
             WHERE tenant_id = ? AND status = 'ACTIVE'
               AND (channel_id = ? OR channel_id IS NULL)
             ORDER BY scope_order ASC, trigger_priority ASC, updated_at DESC`,
            [channelId, tenantId, channelId]
        );
        return rows;
    }

    // ── Provisioning ──────────────────────────────────────────────────────────

    async findFlowByExternalRef(tenantId, externalRef) {
        const [rows] = await connection.execute(
            `SELECT id, tenant_id, channel_id, external_ref, name, schema_version, structure, trigger_condition,
                    trigger_priority, timeout_seconds, agent_ring_timeout, status, updated_at
             FROM ivr_flows WHERE tenant_id = ? AND external_ref = ? LIMIT 1`,
            [tenantId, externalRef]
        );
        return rows[0] ? { ...rows[0], structure: parseJson(rows[0].structure, null) } : null;
    }

    async listFlows(tenantId) {
        const [rows] = await connection.execute(
            `SELECT id, channel_id, external_ref, name, schema_version, trigger_condition, trigger_priority,
                    timeout_seconds, agent_ring_timeout, status, updated_at
             FROM ivr_flows WHERE tenant_id = ? ORDER BY id ASC`,
            [tenantId]
        );
        return rows;
    }

    async upsertFlow(tenantId, externalRef, fields) {
        const {
            channel_id = null, name, schema_version = 1, structure, trigger_condition = 'ALWAYS',
            trigger_priority = 0, timeout_seconds = 10, agent_ring_timeout = 60, status = 'INACTIVE',
        } = fields;
        await connection.execute(
            `INSERT INTO ivr_flows (tenant_id, channel_id, external_ref, name, schema_version, structure,
                                    trigger_condition, trigger_priority, timeout_seconds, agent_ring_timeout,
                                    status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
             ON DUPLICATE KEY UPDATE
                 channel_id = VALUES(channel_id), name = VALUES(name), schema_version = VALUES(schema_version),
                 structure = VALUES(structure), trigger_condition = VALUES(trigger_condition),
                 trigger_priority = VALUES(trigger_priority), timeout_seconds = VALUES(timeout_seconds),
                 agent_ring_timeout = VALUES(agent_ring_timeout), status = VALUES(status), updated_at = NOW()`,
            [tenantId, channel_id, externalRef, name, schema_version, JSON.stringify(structure),
                trigger_condition, trigger_priority, timeout_seconds, agent_ring_timeout, status]
        );
        return this.findFlowByExternalRef(tenantId, externalRef);
    }

    async createAudioAsset(tenantId, { external_ref = null, name, storage_provider = 's3', storage_key, mime_type = null,
        duration_seconds = null, file_size_bytes = null }) {
        const [result] = await connection.execute(
            `INSERT INTO audio_assets (tenant_id, external_ref, name, storage_provider, storage_key, mime_type,
                                       duration_seconds, file_size_bytes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [tenantId, external_ref, name, storage_provider, storage_key, mime_type, duration_seconds, file_size_bytes]
        );
        return this.findAudioAsset(result.insertId, tenantId);
    }

    async findAudioAsset(assetId, tenantId) {
        const [rows] = await connection.execute(
            `SELECT id, tenant_id, external_ref, name, storage_provider, storage_key, mime_type, duration_seconds,
                    file_size_bytes, created_at
             FROM audio_assets WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL) LIMIT 1`,
            [assetId, tenantId]
        );
        return rows[0] ?? null;
    }

    async listAudioAssets(tenantId) {
        const [rows] = await connection.execute(
            `SELECT id, tenant_id, external_ref, name, storage_provider, storage_key, mime_type, duration_seconds,
                    file_size_bytes, created_at
             FROM audio_assets WHERE tenant_id = ? OR tenant_id IS NULL ORDER BY id ASC`,
            [tenantId]
        );
        return rows;
    }

    // ── Sessions ──────────────────────────────────────────────────────────────

    async createSession({ callId, ivrFlowId }) {
        const [result] = await connection.execute(
            `INSERT INTO ivr_sessions (call_id, ivr_flow_id, completed, started_at, created_at, updated_at)
             VALUES (?, ?, 0, NOW(), NOW(), NOW())`,
            [callId, ivrFlowId ?? null]
        );
        return result.insertId;
    }

    // Params: { sessionId, digit, nodeId }
    async recordInput({ sessionId, digit, nodeId }) {
        await connection.execute(
            `INSERT INTO ivr_session_inputs (ivr_session_id, node_name, input, pressed_at, created_at, updated_at)
             VALUES (?, ?, ?, NOW(), NOW(), NOW())`,
            [sessionId, nodeId ?? '', digit]
        );
    }

    // outcome: 'transferred'|'hung_up'|'timeout'|'error'
    async closeSession(sessionId, outcome, endedAt = null, durationSeconds = null) {
        const normalizedDuration = Number.isFinite(Number(durationSeconds))
            ? Math.max(0, Math.floor(Number(durationSeconds)))
            : null;
        const endedAtValue = endedAt instanceof Date ? endedAt : null;

        await connection.execute(
            `UPDATE ivr_sessions
             SET outcome = ?,
                 completed = 1,
                 ended_at = COALESCE(?, NOW()),
                 duration = COALESCE(?, TIMESTAMPDIFF(SECOND, started_at, COALESCE(?, NOW())), 0),
                 updated_at = NOW()
             WHERE id = ?`,
            [outcome, endedAtValue, normalizedDuration, endedAtValue, sessionId]
        );
    }

    async listSessionsForCall(callId) {
        const [sessions] = await connection.execute(
            `SELECT id, ivr_flow_id, completed, outcome, duration, started_at, ended_at
             FROM ivr_sessions WHERE call_id = ? ORDER BY id ASC`,
            [callId]
        );
        if (!sessions.length) return [];
        const placeholders = sessions.map(() => '?').join(',');
        const [inputs] = await connection.execute(
            `SELECT ivr_session_id, node_name, input, pressed_at
             FROM ivr_session_inputs WHERE ivr_session_id IN (${placeholders}) ORDER BY id ASC`,
            sessions.map((s) => s.id)
        );
        return sessions.map((s) => ({ ...s, inputs: inputs.filter((i) => i.ivr_session_id === s.id) }));
    }

    // ── Audio ─────────────────────────────────────────────────────────────────

    // Hold audio for a queue: the queue's own asset, else the platform default.
    // Returns { source: 'queue'|'platform', storage_key, storage_disk } or null.
    async getQueueAudio(queueId, tenantId) {
        if (queueId) {
            const [rows] = await connection.execute(
                `SELECT a.id, a.storage_key, a.storage_provider
                 FROM queues q
                 JOIN audio_assets a ON a.id = q.hold_audio_asset_id
                 WHERE q.id = ? AND q.tenant_id = ? AND (a.tenant_id = q.tenant_id OR a.tenant_id IS NULL)
                 LIMIT 1`,
                [queueId, tenantId]
            );
            if (rows[0]?.storage_key) return { source: 'queue', ...toStorageRef(rows[0]) };
        }

        const [rows] = await connection.execute(
            `SELECT id, storage_key, storage_provider FROM audio_assets
             WHERE tenant_id IS NULL AND external_ref = ? LIMIT 1`,
            [DEFAULT_HOLD_AUDIO_REF]
        );
        return rows[0]?.storage_key ? { source: 'platform', ...toStorageRef(rows[0]) } : null;
    }

    // One audio asset, owned by the tenant or platform-wide.
    async findAudioFile(audioAssetId, tenantId = null) {
        const [rows] = await connection.execute(
            `SELECT id, storage_key, storage_provider FROM audio_assets
             WHERE id = ? AND (? IS NULL OR tenant_id = ? OR tenant_id IS NULL)
             LIMIT 1`,
            [audioAssetId, tenantId, tenantId]
        );
        return toStorageRef(rows[0]);
    }

    // ── Call row helpers ──────────────────────────────────────────────────────

    // The call fields IVR agent assignment needs.
    async findCallRecord(callId) {
        const [rows] = await connection.execute(
            `SELECT id, provider_call_id, tenant_id, channel_id, channel, channel_address, queue_id,
                    customer_address, customer_address_type, customer_name, ringing_at, status
             FROM calls WHERE id = ? LIMIT 1`,
            [callId]
        );
        return rows[0] ?? null;
    }

    // Updates state (and optionally status). Pass status='RINGING' when moving IVR → QUEUE.
    async updateCallState(callId, state, status = null) {
        if (status) {
            // COALESCE sets ringing_at the first time the call enters RINGING
            // (IVR calls skip the normal RINGING phase).
            await connection.execute(
                `UPDATE calls SET state = ?, status = ?, ringing_at = COALESCE(ringing_at, NOW()), updated_at = NOW() WHERE id = ?`,
                [state, status, callId]
            );
        } else {
            await connection.execute(`UPDATE calls SET state = ?, updated_at = NOW() WHERE id = ?`, [state, callId]);
        }
    }
}

export default new IvrRepository();
