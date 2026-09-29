// src/infra/logging/redaction.js
// Secrets out of every record (always), customer addresses masked (opt-in).
import { PII_FIELDS, REDACT_CENSOR, REDACT_EXTRA_PATHS, REDACT_KEYS } from './policy.js';

/** pino `redact` option. */
export const redactOptions = Object.freeze({
    paths: [...REDACT_KEYS.flatMap((k) => [k, `*.${k}`]), ...REDACT_EXTRA_PATHS],
    censor: REDACT_CENSOR,
});

const piiFields = new Set(PII_FIELDS);

function maskDigits(s) {
    return s.length <= 4 ? '***' : `${s.slice(0, s.startsWith('+') ? 4 : 3)}${'*'.repeat(Math.max(3, s.length - 7))}${s.slice(-3)}`;
}

/** Phone numbers (+E.164, 00-prefixed) and numeric SIP users inside a string. */
export function maskPii(text) {
    return String(text)
        .replace(/\+\d{7,15}\b/g, maskDigits)
        .replace(/\b(sips?:)(\+?\d{5,15})@/gi, (_, scheme, user) => `${scheme}${maskDigits(user)}@`)
        .replace(/\b00\d{8,15}\b/g, maskDigits);
}

function maskFields(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || obj instanceof Error || depth > 2) return obj;
    const out = Array.isArray(obj) ? [] : {};
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') out[k] = piiFields.has(k) ? maskDigits(v.replace(/^sips?:/i, '')) : maskPii(v);
        else if (typeof v === 'number' && piiFields.has(k)) out[k] = maskDigits(String(v));
        else out[k] = maskFields(v, depth + 1);
    }
    return out;
}

/** pino `hooks.logMethod` that masks every argument (fields and message). */
export function maskingHook(args, method) {
    method.apply(this, args.map((a) => (typeof a === 'string' ? maskPii(a) : maskFields(a))));
}
