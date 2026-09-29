// src/infra/logging/errors.js
// The `err` serializer: what an error keeps in a record (policy.js, Errors).
// Only named, bounded parts — an axios error otherwise drags its request
// config (with the Authorization header), the socket and the response in.
import { ERROR_BODY_MAX, ERROR_FIELDS, ERROR_MAX_DEPTH, ERROR_TEXT_MAX } from './policy.js';
import { redact } from './redaction.js';

const cut = (s, max) => (s.length > max ? `${s.slice(0, max)}… (${s.length - max} more)` : s);

function urlWithoutQuery(url) {
    return typeof url === 'string' ? url.split('?')[0] : undefined;
}

function bodyPreview(data) {
    if (data == null) return undefined;
    let text;
    try { text = typeof data === 'string' ? data : JSON.stringify(redact(data)); } catch { text = String(data); }
    return cut(text, ERROR_BODY_MAX);
}

export function serializeError(err, depth = 0) {
    if (err == null || typeof err !== 'object') return err;
    const out = {
        type: err.name ?? err.constructor?.name ?? 'Error',
        message: cut(String(err.message ?? ''), ERROR_TEXT_MAX),
    };
    if (typeof err.stack === 'string') out.stack = cut(err.stack, ERROR_TEXT_MAX);
    for (const k of ERROR_FIELDS) {
        const v = err[k];
        if (v != null && typeof v !== 'object' && typeof v !== 'function') out[k] = typeof v === 'string' ? cut(v, ERROR_TEXT_MAX) : v;
    }
    // HTTP client errors (axios): enough to tell what failed, nothing that authenticates.
    if (err.isAxiosError || (err.config && typeof err.config === 'object' && 'url' in err.config)) {
        out.http = {
            method: err.config?.method?.toUpperCase(),
            url: urlWithoutQuery(err.config?.url),
            status: err.response?.status,
            body: bodyPreview(err.response?.data),
        };
    }
    if (depth < ERROR_MAX_DEPTH) {
        if (err.cause != null) out.cause = serializeError(err.cause, depth + 1);
        if (Array.isArray(err.errors)) out.errors = err.errors.slice(0, 3).map((e) => serializeError(e, depth + 1));
    }
    return out;
}
