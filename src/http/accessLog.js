// src/http/accessLog.js
// One access-log record per HTTP request (component http.access), with the
// request id bound to everything logged while the request is handled.
//   2xx/3xx info · 4xx warn · 5xx error · /health and unmatched routes debug
// Query strings are left out (webhook verification puts a token there).
import { logger, runWithLogContext } from '../infra/logging/logger.js';
import { COMPONENTS } from '../infra/logging/policy.js';

const log = logger(COMPONENTS.access);
const QUIET = new Set(['/health']);

export function registerAccessLog(fastify) {
    // Callback style: the rest of the request (hooks, handler) runs inside the context.
    fastify.addHook('onRequest', (request, reply, done) => {
        reply.header('x-request-id', request.id);
        runWithLogContext({ requestId: request.id }, done);
    });

    fastify.addHook('onResponse', async (request, reply) => {
        const path = request.url.split('?')[0];
        const status = reply.statusCode;
        const route = request.routeOptions?.url;
        const fields = {
            method: request.method, path, status, ms: Math.round(reply.elapsedTime),
            ip: request.ip, ...(route && route !== path ? { route } : {}),
        };
        const level = QUIET.has(path) || !route ? 'debug' : status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
        log[level](fields, `${request.method} ${path} ${status}`);
    });
}
