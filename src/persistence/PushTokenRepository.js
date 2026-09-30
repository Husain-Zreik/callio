// src/persistence/PushTokenRepository.js
// Push targets per agent device and provider (FCM, APNS_VOIP, ONESIGNAL).
import connection from '../../config/dbConnection.js';

class PushTokenRepository {
    // Upsert the token for (agent, device, provider). A token moving to a new
    // agent (shared device, account switch) is removed from its previous owner.
    async register(agentId, { deviceId, platform, provider, token }) {
        await connection.execute(
            `DELETE FROM agent_push_tokens WHERE provider = ? AND token = ? AND agent_id != ?`,
            [provider, token, agentId]
        );
        await connection.execute(
            `INSERT INTO agent_push_tokens (agent_id, device_id, platform, provider, token, is_active, last_seen_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, NOW(), NOW(), NOW())
             ON DUPLICATE KEY UPDATE
                 platform = VALUES(platform), token = VALUES(token), is_active = 1,
                 last_seen_at = NOW(), updated_at = NOW()`,
            [agentId, deviceId, platform, provider, token]
        );
    }

    async unregisterDevice(agentId, deviceId) {
        const [result] = await connection.execute(
            'DELETE FROM agent_push_tokens WHERE agent_id = ? AND device_id = ?',
            [agentId, deviceId]
        );
        return result.affectedRows;
    }

    // Active tokens for these agents from one provider, optionally one platform,
    // optionally excluding one device (the one that just answered). Each row
    // carries its agent's consumer_id: a push goes out with that consumer's
    // credentials.
    async getTokens(agentIds, provider, { platform = null, excludeDeviceId = null } = {}) {
        const ids = [...new Set((agentIds || []).filter((id) => id != null))];
        if (!ids.length) return [];
        const placeholders = ids.map(() => '?').join(',');
        const params = [...ids, provider];
        let extra = '';
        if (platform) { extra += ' AND p.platform = ?'; params.push(platform); }
        if (excludeDeviceId) { extra += ' AND p.device_id != ?'; params.push(excludeDeviceId); }
        const [rows] = await connection.execute(
            `SELECT p.agent_id, p.device_id, p.platform, p.token, t.consumer_id
             FROM agent_push_tokens p
             JOIN agents a ON a.id = p.agent_id
             JOIN tenants t ON t.id = a.tenant_id
             WHERE p.agent_id IN (${placeholders}) AND p.provider = ? AND p.is_active = 1 ${extra}`,
            params
        );
        return rows;
    }

    // Called when a provider reports a token as invalid/unregistered.
    async removeToken(provider, token) {
        const [result] = await connection.execute(
            'DELETE FROM agent_push_tokens WHERE provider = ? AND token = ?',
            [provider, token]
        );
        return result.affectedRows;
    }
}

export default new PushTokenRepository();
