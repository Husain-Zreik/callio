// src/realtime/handlers/signingKeys.js
// A consumer revoked an agent-token signing key (Management API): end every
// socket that authenticated with it, on every worker. Their app reconnects
// with a token signed by a current key, or stays out.
import EventBus from '../../core/EventBus.js';
import { roomManager } from '../managers/RoomManager.js';
import { forgetSigningSecret } from '../middleware/authMiddleware.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('realtime.handlers.signingKeys');

export function registerSigningKeyListeners() {
    EventBus.on('consumer:signing_key_revoked', ({ consumerId, kid }) => {
        forgetSigningSecret(consumerId, kid);
        roomManager.disconnectSigningKey(consumerId, kid);
        log.info({ consumerId, kid }, 'Signing key revoked — its sockets disconnected');
    });
}
