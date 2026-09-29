// src/infra/logging/redaction.js
// Secrets out of every record (always), customer addresses masked (opt-in).
//
// Redaction is a key scan, not pino's path-based `redact`: its wildcard paths
// cost ~8 µs per record and stop one level down, while a scan of a record's
// few keys costs well under 1 µs and reaches REDACT_DEPTH levels. Objects are
// copied only when a secret is actually found.
import { PII_FIELDS, REDACT_CENSOR, REDACT_DEPTH, REDACT_KEYS } from './policy.js';

const secretKeys = new Set(REDACT_KEYS);
const isSecretKey = (k) => secretKeys.has(k.toLowerCase());
const isPlainObject = (v) => v !== null && typeof v === 'object' && !(v instanceof Error)
    && !ArrayBuffer.isView(v) && !(v instanceof Date);

/** The value with every secret key's value replaced; the same object when there is nothing to redact. */
export function redact(value, depth = 0) {
    if (depth >= REDACT_DEPTH || !isPlainObject(value)) return value;
    let copy = null;
    const keys = Array.isArray(value) ? null : Object.keys(value);
    const n = keys ? keys.length : Math.min(value.length, 50);
    for (let i = 0; i < n; i++) {
        const k = keys ? keys[i] : i;
        const v = value[k];
        let next = v;
        if (keys && isSecretKey(k)) next = v == null ? v : REDACT_CENSOR;
        else if (v !== null && typeof v === 'object') next = redact(v, depth + 1);
        if (next !== v) {
            copy ??= Array.isArray(value) ? [...value] : { ...value };
            copy[k] = next;
        }
    }
    return copy ?? value;
}

// ── PII (LOG_MASK_PII=true) ─────────────────────────────────────────────────

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
    if (!isPlainObject(obj) || depth > 2) return obj;
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
