// src/repositories/IvrRepository.js
// All DB access for IVR menus, sessions, and session inputs.
import connection from '../../config/dbConnection.js';

class IvrRepository {
    // Lightweight menu fetch (id + name only) — used for lifecycle log labels.
    async findMenuHeader(ivrMenuId, businessId = null) {
        const [rows] = await connection.execute(
            `SELECT id, name
             FROM ivr_menus
             WHERE id = ?
               AND (? IS NULL OR business_id = ?)
             LIMIT 1`,
            [ivrMenuId, businessId, businessId]
        );
        return rows[0] ?? null;
    }

    // ── Menu ─────────────────────────────────────────────────────────────────

    // Fetch a single IVR menu with its structure and audio metadata.
    // Returns { id, name, status, timeout_seconds, structure, audioFilesById }
    // where audioFilesById is a map of { [audioFileId]: { id, storage_key, storage_disk } }.
    async findMenu(ivrMenuId, businessId = null) {
        const [rows] = await connection.execute(
            `SELECT
                m.id,
                m.name,
                m.structure,
                m.timeout_seconds,
                m.status
             FROM ivr_menus m
             WHERE m.id = ?
               AND (? IS NULL OR m.business_id = ?)
             LIMIT 1`,
            [ivrMenuId, businessId, businessId]
        );

        const menu = rows[0];
        if (!menu) return null;

        // Parse JSON structure stored in DB
        let structure = { nodes: [], edges: [] };
        if (menu.structure) {
            try {
                structure = typeof menu.structure === 'string'
                    ? JSON.parse(menu.structure)
                    : menu.structure;
            } catch {
                console.error(`[IvrRepository] Failed to parse structure for menu ${ivrMenuId}`);
            }
        }

        // Collect every audioFileId referenced in the structure nodes
        const audioFileIds = [];
        for (const node of (structure.nodes ?? [])) {
            const fid = node.data?.audioFileId;
            if (fid != null) audioFileIds.push(Number(fid));
        }

        // Fetch storage metadata for those audio files in one query
        let audioFilesById = {};
        if (audioFileIds.length > 0) {
            const placeholders = audioFileIds.map(() => '?').join(',');
            const queryParams = [...audioFileIds];
            let audioQuery = `SELECT id, storage_key, storage_disk
                 FROM media_files
                 WHERE type = 'audio'
                   AND id IN (${placeholders})`;

            if (businessId != null) {
                audioQuery += ' AND business_id = ?';
                queryParams.push(businessId);
            }

            const [audioRows] = await connection.execute(audioQuery, queryParams);
            for (const row of audioRows) {
                audioFilesById[row.id] = row;
            }
        }

        return {
            id: menu.id,
            name: menu.name,
            status: menu.status,
            timeout_seconds: menu.timeout_seconds ?? 10,
            structure,
            audioFilesById, // { [audioFileId]: { id, storage_key, storage_disk } }
        };
    }

    // ── Sessions ──────────────────────────────────────────────────────────────

    // Create an IVR session row when a caller enters the IVR flow.
    // Returns the new sessionId.
    async createSession({ callId, ivrMenuId, businessId }) {
        const [result] = await connection.execute(
            `INSERT INTO ivr_sessions
                (call_id, ivr_menu_id, business_id, completed, started_at, created_at, updated_at)
             VALUES (?, ?, ?, 0, NOW(), NOW(), NOW())`,
            [callId, ivrMenuId, businessId ?? null]
        );
        return result.insertId;
    }

    // Record a single DTMF input within a session.
    // Params: { sessionId, digit, nodeId }
    async recordInput({ sessionId, digit, nodeId }) {
        await connection.execute(
            `INSERT INTO ivr_session_inputs
                (ivr_session_id, node_name, input, pressed_at, created_at, updated_at)
             VALUES (?, ?, ?, NOW(), NOW(), NOW())`,
            [sessionId, nodeId ?? '', digit]
        );
    }

    // ── Queue Audio ──────────────────────────────────────────────────────────

    // Resolve the queue waiting audio for a business.
    // Priority: business override → platform default → null.
    // Returns { source: 'business'|'platform', storage_key, storage_disk } or null.
    async getQueueAudio(businessId) {
        // 1. Business override — read ivr_queue_audio_file_id from call_settings JSON
        const [bizRows] = await connection.execute(
            `SELECT
                CAST(JSON_EXTRACT(call_settings, '$.ivr_queue_audio_file_id') AS UNSIGNED) AS audio_file_id
             FROM businesses WHERE id = ? LIMIT 1`,
            [businessId]
        );

        const audioFileId = bizRows[0]?.audio_file_id ? Number(bizRows[0].audio_file_id) : null;

        if (audioFileId) {
            const [fileRows] = await connection.execute(
                `SELECT storage_key, storage_disk
                 FROM media_files
                 WHERE type = 'audio' AND id = ? AND business_id = ?
                 LIMIT 1`,
                [audioFileId, businessId]
            );
            if (fileRows[0]?.storage_key) {
                return {
                    source: 'business',
                    storage_key: fileRows[0].storage_key,
                    storage_disk: fileRows[0].storage_disk ?? 'public',
                };
            }
        }

        // 2. Platform default — read from platform_settings table
        const [settingRows] = await connection.execute(
            `SELECT \`key\`, value FROM platform_settings WHERE \`key\` IN (?, ?)`,
            ['ivr.queue_audio_storage_key', 'ivr.queue_audio_storage_disk']
        );

        const byKey = {};
        for (const row of settingRows) {
            // value is stored as JSON (may be a JSON string like '"some/path"' or null)
            try { byKey[row.key] = JSON.parse(row.value); } catch { byKey[row.key] = row.value; }
        }

        const storageKey = byKey['ivr.queue_audio_storage_key'] ?? null;
        const storageDisk = byKey['ivr.queue_audio_storage_disk'] ?? 'public';

        if (storageKey) {
            return { source: 'platform', storage_key: storageKey, storage_disk: storageDisk };
        }

        return null;
    }

    // Lightweight call row fetch for IVR agent assignment — only the fields IVR needs.
    async findCallRecord(callId) {
        const [rows] = await connection.execute(
            `SELECT id, wacid, business_id, business_number_id, client_number_id,
                    caller_name, caller_username, caller_number, callee_name, callee_username, callee_number, ringing_at, status
             FROM calls WHERE id = ? LIMIT 1`,
            [callId]
        );
        return rows[0] ?? null;
    }

    // Updates state (and optionally status) of a call. Pass status='RINGING' when moving IVR → QUEUE.
    async updateCallState(callId, state, status = null) {
        if (status) {
            await connection.execute(
                // COALESCE ensures ringing_at is set the first time a call enters RINGING
                // state (IVR→QUEUE transition). IVR calls skip the normal RINGING phase so
                // ringing_at is often null, which causes the manager timer to show 00:00.
                `UPDATE calls SET state = ?, status = ?, ringing_at = COALESCE(ringing_at, NOW()), updated_at = NOW() WHERE id = ?`,
                [state, status, callId]
            );
        } else {
            await connection.execute(
                `UPDATE calls SET state = ?, updated_at = NOW() WHERE id = ?`,
                [state, callId]
            );
        }
    }

    // Fetch storage metadata for a single audio file.
    async findAudioFile(audioFileId, businessId = null) {
        const [rows] = await connection.execute(
            `SELECT storage_key, storage_disk
             FROM media_files
             WHERE id = ?
               AND type = 'audio'
               AND (? IS NULL OR business_id = ?)
             LIMIT 1`,
            [audioFileId, businessId, businessId]
        );
        return rows[0] ?? null;
    }

    // Close a session with an outcome and exact timing from Node runtime.
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
}

export default new IvrRepository();
