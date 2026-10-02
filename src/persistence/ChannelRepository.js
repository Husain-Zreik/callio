// src/persistence/ChannelRepository.js
// Customer-facing lines (WhatsApp numbers, SIP DIDs) and their credentials.
// A line is shared (inbound_queue_id: routed by its queue / IVR) or personal
// (owner_agent_id: it rings that agent, and only they call out from it).
import connection from '../../config/dbConnection.js';
import { decryptJson, encryptJson } from '../infra/crypto/secretBox.js';

const CHANNEL_COLUMNS = `id, tenant_id, external_ref, type, display_name, address, provider_account_id,
    sip_trunk_id, inbound_queue_id, owner_agent_id, ring_timeout_seconds, recording_enabled, status`;

class ChannelRepository {
    async findById(channelId) {
        if (!channelId) return null;
        const [rows] = await connection.execute(
            `SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ? LIMIT 1`,
            [channelId]
        );
        return rows[0] ?? null;
    }

    async findForTenant(channelId, tenantId) {
        const [rows] = await connection.execute(
            `SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ? AND tenant_id = ? LIMIT 1`,
            [channelId, tenantId]
        );
        return rows[0] ?? null;
    }

    async findByExternalRef(tenantId, externalRef) {
        const [rows] = await connection.execute(
            `SELECT ${CHANNEL_COLUMNS} FROM channels WHERE tenant_id = ? AND external_ref = ? LIMIT 1`,
            [tenantId, externalRef]
        );
        return rows[0] ?? null;
    }

    // id → external_ref, for call views.
    async getRefsByIds(channelIds) {
        const ids = [...new Set((channelIds || []).filter((id) => id != null))];
        if (!ids.length) return new Map();
        const [rows] = await connection.execute(
            `SELECT id, external_ref FROM channels WHERE id IN (${ids.map(() => '?').join(',')})`,
            ids
        );
        return new Map(rows.map((r) => [String(r.id), r.external_ref]));
    }

    async listForTenant(tenantId) {
        const [rows] = await connection.execute(
            `SELECT ${CHANNEL_COLUMNS} FROM channels WHERE tenant_id = ? ORDER BY id ASC`,
            [tenantId]
        );
        return rows;
    }

    // SIP ingress identifies a line by the dialled number (the DID).
    async findActiveByAddress(type, address) {
        const [rows] = await connection.execute(
            `SELECT ${CHANNEL_COLUMNS} FROM channels
             WHERE type = ? AND address = ? AND status = 'ACTIVE' LIMIT 1`,
            [type, String(address)]
        );
        return rows[0] ?? null;
    }

    // Channel ingress identifies a line by the provider's account id for it
    // (WhatsApp: Meta's phone_number_id).
    async findActiveByProviderAccount(type, providerAccountId) {
        const [rows] = await connection.execute(
            `SELECT ${CHANNEL_COLUMNS} FROM channels
             WHERE type = ? AND provider_account_id = ? AND status = 'ACTIVE' LIMIT 1`,
            [type, String(providerAccountId)]
        );
        return rows[0] ?? null;
    }

    // Inbound SIP calls identify the line by the dialled DID.
    async findActiveSipByAddress(address) {
        const [rows] = await connection.execute(
            `SELECT ${CHANNEL_COLUMNS} FROM channels
             WHERE type = 'SIP' AND address = ? AND status = 'ACTIVE' LIMIT 1`,
            [address]
        );
        return rows[0] ?? null;
    }

    async getCredentials(channelId) {
        const [rows] = await connection.execute('SELECT credentials FROM channels WHERE id = ?', [channelId]);
        return rows[0]?.credentials ? decryptJson(rows[0].credentials) : null;
    }

    async upsert(tenantId, externalRef, fields) {
        const {
            type, display_name = null, address, provider_account_id = null, sip_trunk_id = null,
            credentials, inbound_queue_id = null, owner_agent_id = null, ring_timeout_seconds = null,
            recording_enabled = false, status = 'ACTIVE',
        } = fields;
        // credentials: undefined = keep existing, null = clear, object = replace.
        const encrypted = credentials === undefined ? undefined : encryptJson(credentials);
        await connection.execute(
            `INSERT INTO channels (tenant_id, external_ref, type, display_name, address, provider_account_id,
                                   sip_trunk_id, credentials, inbound_queue_id, owner_agent_id, ring_timeout_seconds,
                                   recording_enabled, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
             ON DUPLICATE KEY UPDATE
                 type = VALUES(type), display_name = VALUES(display_name), address = VALUES(address),
                 provider_account_id = VALUES(provider_account_id), sip_trunk_id = VALUES(sip_trunk_id),
                 credentials = ${encrypted === undefined ? 'credentials' : 'VALUES(credentials)'},
                 inbound_queue_id = VALUES(inbound_queue_id), owner_agent_id = VALUES(owner_agent_id),
                 ring_timeout_seconds = VALUES(ring_timeout_seconds), recording_enabled = VALUES(recording_enabled),
                 status = VALUES(status), updated_at = NOW()`,
            [tenantId, externalRef, type, display_name, address, provider_account_id, sip_trunk_id,
                encrypted ?? null, inbound_queue_id, owner_agent_id, ring_timeout_seconds, recording_enabled ? 1 : 0, status]
        );
        return this.findByExternalRef(tenantId, externalRef);
    }

    // Guarded: not while a live call is on the channel. Its IVR flows go with
    // it (FK cascade); call history keeps channel_id NULL and its own address.
    async deleteIfUnused(channelId, tenantId) {
        const [result] = await connection.execute(
            `DELETE FROM channels WHERE id = ? AND tenant_id = ?
               AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.channel_id = ? AND c.status IN ('INITIATED', 'RINGING', 'IN_PROGRESS'))`,
            [channelId, tenantId, channelId]
        );
        return result.affectedRows;
    }

    async usingInboundQueue(queueId) {
        const [rows] = await connection.execute('SELECT external_ref FROM channels WHERE inbound_queue_id = ?', [queueId]);
        return rows.map((r) => r.external_ref);
    }
}

export default new ChannelRepository();
