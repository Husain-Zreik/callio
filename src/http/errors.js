// src/http/errors.js
// One error shape for every HTTP response: { error: { code, message } }.
import { logger } from '../infra/logging/logger.js';

const log = logger('http.errors');

export class HttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export function sendError(reply, status, code, message) {
    return reply.code(status).send({ error: { code, message } });
}

export function badRequest(message) {
    return new HttpError(400, 'invalid_request', message);
}

export function notFound(what) {
    return new HttpError(404, 'not_found', `${what} not found`);
}

// Fastify error handler for the /v1 scope.
export function httpErrorHandler(error, request, reply) {
    if (error instanceof HttpError) return sendError(reply, error.status, error.code, error.message);
    if (error.validation) return sendError(reply, 400, 'invalid_request', error.message);
    if (error.statusCode && error.statusCode < 500) {
        return sendError(reply, error.statusCode, 'invalid_request', error.message);
    }
    log.error({ err: error }, `${request.method} ${request.url} failed`);
    return sendError(reply, 500, 'internal_error', 'Internal error');
}
