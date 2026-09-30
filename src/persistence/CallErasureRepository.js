// src/persistence/CallErasureRepository.js
// Deleting a call, and erasing one customer's personal data from a tenant's
// calls (core/calls/CallErasure.js). Only ended calls are touched.
import connection from '../../config/dbConnection.js';

const ENDED = "('TERMINATED', 'FAILED')";
const inList = (ids) => ids.map(() => '?').join(',');

class CallErasureRepository {
    async findCall(tenantId, callId) {
        const [rows] = await connection.execute('SELECT id, status FROM calls WHERE id = ? AND tenant_id = ?', [callId, tenantId]);
        return rows[0] ?? null;
    }

    // Ended calls of a tenant with this customer address, a batch at a time
    // (the (tenant_id, customer_address) index serves it).
    async endedCallsOfCustomer(tenantId, address, limit) {
        const [rows] = await connection.execute(
            `SELECT id FROM calls WHERE tenant_id = ? AND customer_address = ? AND status IN ${ENDED}
             ORDER BY id LIMIT ${Number(limit)}`,
            [tenantId, address]
        );
        return rows.map((r) => r.id);
    }

    async countActiveCallsOfCustomer(tenantId, address) {
        const [[row]] = await connection.execute(
            `SELECT COUNT(*) AS n FROM calls WHERE tenant_id = ? AND customer_address = ? AND status NOT IN ${ENDED}`,
            [tenantId, address]
        );
        return Number(row.n);
    }

    async recordingsOf(callIds) {
        if (!callIds.length) return [];
        const [rows] = await connection.execute(
            `SELECT id, call_id, status, storage_provider, storage_key FROM call_recordings WHERE call_id IN (${inList(callIds)})`,
            callIds
        );
        return rows;
    }

    async deleteRecordingRows(recordingIds) {
        if (!recordingIds.length) return 0;
        const [r] = await connection.execute(`DELETE FROM call_recordings WHERE id IN (${inList(recordingIds)})`, recordingIds);
        return r.affectedRows;
    }

    // The events sent about these calls carry the customer too.
    async deleteDeliveries(callIds) {
        if (!callIds.length) return 0;
        const [r] = await connection.execute(`DELETE FROM webhook_deliveries WHERE call_id IN (${inList(callIds)})`, callIds);
        return r.affectedRows;
    }

    // Deletes an ended call; its legs, lifecycle log, transfers, IVR sessions
    // and recording rows go with it (ON DELETE CASCADE). Guarded on the call
    // still being ended and in the tenant.
    async deleteEndedCall(tenantId, callId) {
        const [r] = await connection.execute(
            `DELETE FROM calls WHERE id = ? AND tenant_id = ? AND status IN ${ENDED}`,
            [callId, tenantId]
        );
        return r.affectedRows > 0;
    }

    // Keeps the calls (for history and reports) without anything that
    // identifies or describes the customer: address, name, your refs and
    // metadata, provider payload details, SDP (IP addresses), the lifecycle
    // log and IVR key presses.
    async anonymise(tenantId, callIds) {
        if (!callIds.length) return 0;
        const ids = inList(callIds);
        await connection.execute(`DELETE FROM call_lifecycle_events WHERE call_id IN (${ids})`, callIds);
        await connection.execute(`DELETE FROM ivr_sessions WHERE call_id IN (${ids})`, callIds);
        await connection.execute(
            `UPDATE call_connections SET local_sdp = NULL, remote_sdp = NULL, ice_candidates = NULL WHERE call_id IN (${ids})`,
            callIds
        );
        const [r] = await connection.execute(
            `UPDATE calls SET customer_address = NULL, customer_name = NULL, external_ref = NULL,
                              consumer_metadata = NULL, metadata = NULL, failure_details = NULL, updated_at = NOW()
             WHERE tenant_id = ? AND id IN (${ids}) AND status IN ${ENDED}`,
            [tenantId, ...callIds]
        );
        return r.affectedRows;
    }
}

export default new CallErasureRepository();
