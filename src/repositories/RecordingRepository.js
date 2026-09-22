// src/repositories/RecordingRepository.js
import connection from "../../config/dbConnection.js";

class RecordingRepository {
    async create(data) {
        const {
            call_id,
            business_id,
            storage_provider = 's3',
            storage_region = 'eu-central-1',
            format = 'ogg',
        } = data;

        const [result] = await connection.execute(`
        INSERT INTO call_recordings (
            call_id,
            business_id,
            storage_provider,
            storage_region,
            format,
            status,
            started_at,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, 'recording', NOW(), NOW(), NOW())
    `, [call_id, business_id, storage_provider, storage_region, format]);

        return { id: result.insertId };
    }

    async findByCallId(callId) {
        const [rows] = await connection.execute(
            'SELECT * FROM call_recordings WHERE call_id = ?',
            [callId]
        );
        return rows[0] || null;
    }

    async updateRecordingUrl(recordingId, url, fileSize) {
        await connection.execute(`
            UPDATE call_recordings
            SET recording_url    = ?,
                file_size_bytes  = ?,
                updated_at       = NOW()
            WHERE id = ?
        `, [url, fileSize, recordingId]);
    }

    async updateStatus(recordingId, status, errorMessage = null) {
        const query = errorMessage
            ? `UPDATE call_recordings
               SET status = ?, error_message = ?, updated_at = NOW()
               WHERE id = ?`
            : `UPDATE call_recordings
               SET status = ?, updated_at = NOW()
               WHERE id = ?`;

        const params = errorMessage
            ? [status, errorMessage, recordingId]
            : [status, recordingId];

        await connection.execute(query, params);
    }

    async markCompleted(recordingId, durationSeconds) {
        await connection.execute(`
            UPDATE call_recordings
            SET status = 'completed',
                duration_seconds = ?,
                completed_at = NOW(),
                updated_at = NOW()
            WHERE id = ?
        `, [durationSeconds, recordingId]);
    }

    async markFailed(recordingId, errorMessage) {
        await connection.execute(`
            UPDATE call_recordings
            SET status = 'failed',
                error_message = ?,
                completed_at = NOW(),
                updated_at = NOW()
            WHERE id = ?
        `, [errorMessage, recordingId]);
    }

    // Called at startup to mark recordings left in-progress by unclean exits as failed.
    async markStaleRecordingsFailed() {
        const [result] = await connection.execute(`
            UPDATE call_recordings
            SET status        = 'failed',
                error_message = 'Server restarted while recording was in progress',
                completed_at  = NOW(),
                updated_at    = NOW()
            WHERE status IN ('recording', 'processing')
        `);
        if (result.affectedRows > 0) {
            console.log(`[RecordingRepository] ⚠️ Marked ${result.affectedRows} stale recording(s) as failed`);
        }
        return result.affectedRows;
    }
}

export default new RecordingRepository();
