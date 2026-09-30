// src/persistence/RetentionRepository.js
// Deletes for the retention job (core/calls/RetentionService). Every delete is
// bounded (LIMIT) so one statement never holds locks for long; the job loops.
import connection from '../../config/dbConnection.js';

const ENDED = "('TERMINATED', 'FAILED')";

class RetentionRepository {
    // One detail table's rows for calls that ended before the cutoff — a
    // batch of calls at a time. Driven from the detail table (which this job
    // keeps bounded) and joined to calls by primary key, so the ever-growing
    // calls history is never scanned. The calls row and its recording stay.
    async deleteCallDetail(table, cutoff, callLimit) {
        const [rows] = await connection.execute(
            `SELECT DISTINCT t.call_id FROM ${table} t JOIN calls c ON c.id = t.call_id
             WHERE c.status IN ${ENDED} AND c.ended_at < ?
             LIMIT ${Number(callLimit)}`,
            [cutoff]
        );
        if (!rows.length) return 0;
        const ids = rows.map((r) => r.call_id);
        const [r] = await connection.execute(`DELETE FROM ${table} WHERE call_id IN (${ids.map(() => '?').join(',')})`, ids);
        return r.affectedRows;
    }

    // The SDP and ICE candidates of legs of calls that ended before the cutoff.
    async scrubConnectionSdp(cutoff, limit) {
        const [rows] = await connection.execute(
            `SELECT k.id FROM call_connections k JOIN calls c ON c.id = k.call_id
             WHERE c.status IN ${ENDED} AND c.ended_at < ?
               AND (k.local_sdp IS NOT NULL OR k.remote_sdp IS NOT NULL OR k.ice_candidates IS NOT NULL)
             LIMIT ${Number(limit)}`,
            [cutoff]
        );
        if (!rows.length) return 0;
        const ids = rows.map((r) => r.id);
        const [r] = await connection.execute(
            `UPDATE call_connections SET local_sdp = NULL, remote_sdp = NULL, ice_candidates = NULL
             WHERE id IN (${ids.map(() => '?').join(',')})`,
            ids
        );
        return r.affectedRows;
    }

    // Delivered or given-up webhook deliveries; PENDING ones are never removed.
    async deleteFinishedDeliveries(cutoff, limit) {
        const [r] = await connection.execute(
            `DELETE FROM webhook_deliveries WHERE status IN ('DELIVERED', 'FAILED') AND created_at < ? ORDER BY id LIMIT ${Number(limit)}`,
            [cutoff]
        );
        return r.affectedRows;
    }

    async tenantsWithSettings() {
        const [rows] = await connection.execute('SELECT id, settings FROM tenants');
        return rows.map((r) => ({ id: r.id, settings: typeof r.settings === 'string' ? JSON.parse(r.settings) : r.settings }));
    }

    // A tenant's completed recordings that started before the cutoff.
    async expiredRecordings(tenantId, cutoff, limit) {
        const [rows] = await connection.execute(
            `SELECT r.id, r.call_id, r.storage_provider, r.storage_key
             FROM call_recordings r JOIN calls c ON c.id = r.call_id
             WHERE c.tenant_id = ? AND r.status = 'completed' AND r.started_at < ?
             ORDER BY r.id LIMIT ${Number(limit)}`,
            [tenantId, cutoff]
        );
        return rows;
    }

    async markRecordingPurged(recordingId) {
        await connection.execute(
            `UPDATE call_recordings SET status = 'purged', purged_at = NOW(), storage_key = NULL, updated_at = NOW()
             WHERE id = ? AND status = 'completed'`,
            [recordingId]
        );
    }
}

export default new RetentionRepository();
