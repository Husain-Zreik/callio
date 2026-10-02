// src/persistence/TenantRepository.js
import connection from '../../config/dbConnection.js';

function parseSettings(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw) ?? {}; } catch { return {}; }
}


const MONITOR_MODES = ['listen', 'whisper', 'barge'];
class TenantRepository {
    async findById(tenantId) {
        const [rows] = await connection.execute(
            'SELECT id, consumer_id, external_ref, name, status, settings FROM tenants WHERE id = ? LIMIT 1',
            [tenantId]
        );
        return rows[0] ? { ...rows[0], settings: parseSettings(rows[0].settings) } : null;
    }

    async findByExternalRef(consumerId, externalRef) {
        const [rows] = await connection.execute(
            `SELECT id, consumer_id, external_ref, name, status, settings
             FROM tenants WHERE consumer_id = ? AND external_ref = ? LIMIT 1`,
            [consumerId, externalRef]
        );
        return rows[0] ? { ...rows[0], settings: parseSettings(rows[0].settings) } : null;
    }

    async getConsumerId(tenantId) {
        const [rows] = await connection.execute('SELECT consumer_id FROM tenants WHERE id = ?', [tenantId]);
        return rows[0]?.consumer_id ?? null;
    }

    async getExternalRef(tenantId) {
        const [rows] = await connection.execute('SELECT external_ref FROM tenants WHERE id = ?', [tenantId]);
        return rows[0]?.external_ref ?? null;
    }

    // Auto-offline policy: take an agent offline after N consecutive missed offers.
    async getAutoOfflineSettings(tenantId) {
        const tenant = await this.findById(tenantId);
        const policy = tenant?.settings?.auto_offline ?? {};
        const threshold = Number(policy.missed_threshold);
        return {
            enabled: Boolean(policy.enabled),
            threshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 3,
        };
    }

    // Who sees the tenant's board: supervisors always; agents too unless
    // settings.team_view is false (a product whose agents are its end users).
    async getBoardSettings(tenantId) {
        const tenant = await this.findById(tenantId);
        return { teamView: tenant?.settings?.team_view !== false };
    }

    // The supervisor modes this tenant allows (settings.monitoring.modes; all
    // three by default). Without 'listen' nobody may monitor its calls.
    async getMonitoringModes(tenantId) {
        const tenant = await this.findById(tenantId);
        const modes = tenant?.settings?.monitoring?.modes;
        if (!Array.isArray(modes)) return [...MONITOR_MODES];
        return MONITOR_MODES.filter((m) => modes.map((x) => String(x).toLowerCase()).includes(m));
    }

    // Storage quota for recordings, in bytes (null = the platform default).
    async getRecordingStorageLimitBytes(tenantId) {
        const tenant = await this.findById(tenantId);
        const limit = Number(tenant?.settings?.recording?.storage_limit_bytes);
        return Number.isFinite(limit) && limit > 0 ? limit : null;
    }

    async upsert(consumerId, externalRef, { name, status = 'ACTIVE', settings = null }) {
        await connection.execute(
            `INSERT INTO tenants (consumer_id, external_ref, name, status, settings, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NOW(), NOW())
             ON DUPLICATE KEY UPDATE
                 name = VALUES(name), status = VALUES(status),
                 settings = COALESCE(VALUES(settings), settings), updated_at = NOW()`,
            [consumerId, externalRef, name, status, settings ? JSON.stringify(settings) : null]
        );
        return this.findByExternalRef(consumerId, externalRef);
    }
}

export default new TenantRepository();
