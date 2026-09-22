// src/repositories/ClientRepository.js
import connection from '../../config/dbConnection.js';

class ClientRepository {
    async findById(clientId) {
        const [rows] = await connection.execute(
            'SELECT id, uuid, name, phone_number, bsuid, username, business_id, assigned_to, call_permission FROM client_numbers WHERE id = ? LIMIT 1',
            [clientId]
        );
        return rows[0] || null;
    }

    async findByPhoneNumber(businessId, phoneNumber) {
        const [rows] = await connection.execute(
            'SELECT id, name FROM client_numbers WHERE business_id = ? AND phone_number = ?',
            [businessId, phoneNumber]
        );
        return rows[0] || null;
    }

    // Matches by phone OR bsuid so a phone-less (username-adopter) caller/callee
    // still resolves to their client_numbers row. Laravel resolves/creates that
    // row synchronously before forwarding the call webhook here, so this should
    // always be the live row — but a merge on the Laravel side can race with
    // this read, so a tombstone (merged_into_id set) is followed once.
    async findByPhoneOrBsuid(businessId, phoneNumber, bsuid) {
        const [rows] = await connection.execute(
            `SELECT id, uuid, name, username, merged_into_id FROM client_numbers
             WHERE business_id = ?
               AND ((phone_number IS NOT NULL AND phone_number = ?)
                 OR (bsuid IS NOT NULL AND bsuid = ?))
             LIMIT 1`,
            [businessId, phoneNumber, bsuid]
        );
        let client = rows[0] || null;

        if (client && !phoneNumber && bsuid) {
            console.log(`[ClientRepository] Matched phone-less caller by bsuid=${bsuid} -> client=${client.id} (business=${businessId})`);
        }

        if (client?.merged_into_id) {
            console.warn(`[ClientRepository] client=${client.id} is a tombstone, following merged_into_id=${client.merged_into_id}`);
            const [survivorRows] = await connection.execute(
                'SELECT id, uuid, name, username FROM client_numbers WHERE id = ? LIMIT 1',
                [client.merged_into_id]
            );
            client = survivorRows[0] || client;
        }

        return client;
    }

    async assignUserId(clientNumberUUID, userId) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const [result] = await connection.execute(
                    'UPDATE client_numbers SET assigned_to = ?, updated_at = NOW() WHERE uuid = ? AND assigned_to IS NULL',
                    [userId, clientNumberUUID]
                );
                return result.affectedRows > 0;
            } catch (err) {
                if (err.code === 'ER_LOCK_WAIT_TIMEOUT' && attempt < 2) {
                    await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
                    continue;
                }
                throw err;
            }
        }
    }

    async unassignUserId(clientNumberUUID) {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await connection.execute(
                    'UPDATE client_numbers SET assigned_to = NULL, updated_at = NOW() WHERE uuid = ?',
                    [clientNumberUUID]
                );
                return;
            } catch (err) {
                if (err.code === 'ER_LOCK_WAIT_TIMEOUT' && attempt < 2) {
                    await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
                    continue;
                }
                throw err;
            }
        }
    }
}

export default new ClientRepository();
