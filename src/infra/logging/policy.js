// src/infra/logging/policy.js
// Logging policy: the vocabulary every record shares. Change what is logged
// and how here, in one place. Pure data (no imports) so the CLIs
// (scripts/logs.js, scripts/log-level.js) can use it without the logger.
//
// Environment settings (level, format, retention …) are in config/envConfig.js
// under `logging`; see .env.example, section LOGGING.

// ── Levels ──────────────────────────────────────────────────────────────────
// error  someone needs to look            warn   unexpected, handled
// info   lifecycle step (call created/answered/ended, agent connected, worker started)
// debug  step detail (SDP, ICE, tracks, relays, pub/sub, HTTP noise)
// trace  per packet / per frame
export const LEVELS = Object.freeze(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export const LEVEL_VALUES = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 });
export const LEVEL_NAMES = Object.freeze(Object.fromEntries(Object.entries(LEVEL_VALUES).map(([k, v]) => [v, k])));
/** A level a logger can be set to (also turns it off). */
export const SETTABLE_LEVELS = Object.freeze([...LEVELS, 'silent']);
export const DEFAULT_LEVEL = 'info';

// ── Record fields ───────────────────────────────────────────────────────────
// The names to use for ids in log fields. Always a field, never inside the
// message text, so `npm run logs` can filter on them exactly.
export const FIELDS = Object.freeze({
    callId: 'callId',                 // calls.id
    callUuid: 'callUuid',             // calls.uuid (the id consumers see)
    providerCallId: 'providerCallId', // the provider's id (WhatsApp call id, SIP Call-ID)
    tenantId: 'tenantId',
    agentId: 'agentId',
    queueId: 'queueId',
    channelId: 'channelId',
    socketId: 'socketId',
    requestId: 'requestId',           // HTTP request (also the x-request-id response header)
    err: 'err',                       // an Error object — the serializer keeps type, message and stack
});

// Fields bound automatically to every record inside a flow (call event,
// socket event, HTTP request) — see context.js. Shown in the head of a
// readable line, in this order.
export const CONTEXT_FIELDS = Object.freeze(['callId', 'tenantId', 'agentId', 'requestId']);

// Fields every record carries from the process.
export const BASE_FIELDS = Object.freeze(['time', 'level', 'msg', 'worker', 'thread', 'pid', 'component', 'mod']);

// ── Redaction (always on) ───────────────────────────────────────────────────
// Values under these keys, at the top level or one level down, are replaced
// by REDACT_CENSOR in every record.
export const REDACT_KEYS = Object.freeze(['token', 'accessToken', 'access_token', 'apiKey', 'api_key', 'secret',
    'appSecret', 'password', 'authorization', 'Authorization', 'cookie', 'credential', 'credentials',
    'privateKey', 'private_key', 'signingKey', 'signing_key', 'masterKey', 'jwt']);
export const REDACT_EXTRA_PATHS = Object.freeze(['req.headers.authorization', 'req.headers.cookie',
    'req.headers["x-api-key"]', 'headers["x-api-key"]', 'req.headers["x-hub-signature-256"]']);
export const REDACT_CENSOR = '[redacted]';

// ── PII masking (LOG_MASK_PII=true) ─────────────────────────────────────────
// Field names whose value is a customer's address (phone number / SIP URI);
// phone numbers inside any string are masked too.
export const PII_FIELDS = Object.freeze(['from', 'to', 'phone', 'phoneNumber', 'phone_number', 'caller', 'callee',
    'msisdn', 'customer', 'customerAddress', 'customer_address', 'address', 'displayPhoneNumber',
    'display_phone_number', 'did', 'number']);

// ── Repeats ─────────────────────────────────────────────────────────────────
// Default window for throttle(): one record per key per window.
export const THROTTLE_WINDOW_MS = 60_000;

// ── Components ──────────────────────────────────────────────────────────────
// logger('<layer>.<area>.<File>') — e.g. channels.sip.SipIngress,
// core.routing.QueueTimeoutService. Levels are set per prefix of this name.
// Reserved components:
export const COMPONENTS = Object.freeze({
    console: 'console',        // console.* from libraries, bridged
    process: 'process',        // worker start, crashes, Node warnings
    logging: 'infra.logging',  // the logging system itself (level changes)
    http: 'http',              // Fastify's own logger
    access: 'http.access',     // one record per HTTP request
});

// ── Runtime level overrides ─────────────────────────────────────────────────
// Where `npm run log-level` stores the override and announces changes (Redis).
export const LOG_LEVELS_KEY = 'callio:log-levels';
export const LOG_LEVELS_CHANNEL = 'callio:log-levels';
