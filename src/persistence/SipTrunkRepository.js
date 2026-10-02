// src/persistence/SipTrunkRepository.js
// Carrier connections SIP channels arrive on and dial out through. A trunk
// with consumer_id NULL is a platform trunk any consumer's channels may use.
import connection from '../../config/dbConnection.js';
import { decryptJson, encryptJson } from '../infra/crypto/secretBox.js';

const COLUMNS = 'id, consumer_id, name, host, port, transport, inbound_source_cidrs, number_rules, status';

function parseCidrs(value) {
    if (value == null) return null;
    if (Array.isArray(value)) return value;
    try { return JSON.parse(value); } catch { return null; }
}

function parseJson(value) {
    if (value == null || typeof value === 'object') return value ?? null;
    try { return JSON.parse(value); } catch { return null; }
}

function row(r) {
    return r ? { ...r, inbound_source_cidrs: parseCidrs(r.inbound_source_cidrs), number_rules: parseJson(r.number_rules) } : null;
}

class SipTrunkRepository {
    async findById(trunkId) {
        if (!trunkId) return null;
        const [rows] = await connection.execute(`SELECT ${COLUMNS} FROM sip_trunks WHERE id = ?`, [trunkId]);
        return row(rows[0]);
    }

    async findByName(name, consumerId = null) {
        const [rows] = await connection.execute(
            `SELECT ${COLUMNS} FROM sip_trunks WHERE name = ? AND consumer_id <=> ? LIMIT 1`,
            [name, consumerId]
        );
        return row(rows[0]);
    }

    // Trunks whose carrier sends numbers in its own format (number_rules set).
    async listWithNumberRules() {
        const [rows] = await connection.execute(`SELECT ${COLUMNS} FROM sip_trunks WHERE number_rules IS NOT NULL`);
        return rows.map(row);
    }

    // Digest credentials for outbound INVITEs ({ username, password }), or null.
    async getCredentials(trunkId) {
        const [rows] = await connection.execute('SELECT credentials FROM sip_trunks WHERE id = ?', [trunkId]);
        return rows[0]?.credentials ? decryptJson(rows[0].credentials) : null;
    }

    // Whether a consumer's channels may use this trunk: its own, or a platform trunk.
    usableBy(trunk, consumerId) {
        return Boolean(trunk) && (trunk.consumer_id == null || String(trunk.consumer_id) === String(consumerId));
    }

    // Creates or updates a trunk by (consumer, name). credentials: undefined keeps them.
    async upsert({ consumerId = null, name, host, port = 5060, transport = 'UDP', credentials, inboundSourceCidrs = null, numberRules = null, status = 'ACTIVE' }) {
        const existing = await this.findByName(name, consumerId);
        const cidrs = inboundSourceCidrs == null ? null : JSON.stringify(inboundSourceCidrs);
        const rules = numberRules == null ? null : JSON.stringify(numberRules);
        if (existing) {
            await connection.execute(
                `UPDATE sip_trunks SET host = ?, port = ?, transport = ?, inbound_source_cidrs = ?, number_rules = ?, status = ?,
                        credentials = COALESCE(?, credentials), updated_at = NOW()
                 WHERE id = ?`,
                [host, port, transport, cidrs, rules, status, credentials ? encryptJson(credentials) : null, existing.id]
            );
            if (credentials === null) {
                await connection.execute('UPDATE sip_trunks SET credentials = NULL WHERE id = ?', [existing.id]);
            }
            return this.findById(existing.id);
        }
        const [result] = await connection.execute(
            `INSERT INTO sip_trunks (consumer_id, name, host, port, transport, credentials, inbound_source_cidrs, number_rules, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [consumerId, name, host, port, transport, credentials ? encryptJson(credentials) : null, cidrs, rules, status]
        );
        return this.findById(result.insertId);
    }
}

export default new SipTrunkRepository();
