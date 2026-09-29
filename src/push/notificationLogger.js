// Verbose push diagnostics: component push.notifications at debug level.
// Turn on with LOG_LEVELS=push.notifications=debug (or `npm run log-level`).
import { logger } from '../infra/logging/logger.js';

const log = logger('push.notifications');

export const notifyLog = (message, data = null) => {
    if (data) log.debug({ data }, message);
    else log.debug(message);
};
