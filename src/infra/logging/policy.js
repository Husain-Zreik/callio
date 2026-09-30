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
// Fields every record carries from the process. service / env / host tell
// services and servers apart in a shared log store (Loki); level is text
// ("info"), which Grafana, Loki and most collectors recognise.
export const BASE_FIELDS = Object.freeze(['time', 'level', 'msg', 'service', 'env', 'host', 'worker', 'thread', 'pid',
    'component', 'mod']);

// ── Redaction (always on) ───────────────────────────────────────────────────
// Values under these keys (case-insensitive, up to REDACT_DEPTH levels deep)
// are replaced by REDACT_CENSOR in every record.
export const REDACT_KEYS = Object.freeze(['token', 'accesstoken', 'access_token', 'refresh_token', 'apikey', 'api_key',
    'secret', 'appsecret', 'client_secret', 'password', 'passwd', 'authorization', 'proxy-authorization', 'cookie',
    'set-cookie', 'credential', 'credentials', 'privatekey', 'private_key', 'signingkey', 'signing_key', 'masterkey',
    'jwt', 'x-api-key', 'x-hub-signature-256', 'rest_api_key', 'restapikey', 'key_p8', 'keypem', 'service_account', 'serviceaccount']);
export const REDACT_DEPTH = 4;
export const REDACT_CENSOR = '[redacted]';

// ── Errors ──────────────────────────────────────────────────────────────────
// What an `err` field keeps: type, message, stack, these scalar properties,
// `cause` / AggregateError members (ERROR_MAX_DEPTH deep), and for HTTP-client
// errors (axios) only { method, url without query, status, body preview }.
// Never request/config/headers/sockets — they carry credentials and are huge.
export const ERROR_FIELDS = Object.freeze(['code', 'errno', 'syscall', 'status', 'statusCode', 'sqlState',
    'sqlMessage', 'sql', 'reason']);
export const ERROR_MAX_DEPTH = 2;
export const ERROR_TEXT_MAX = 4000;      // message / stack / sql, characters
export const ERROR_BODY_MAX = 1000;      // HTTP response body preview, characters

// ── Output limits ───────────────────────────────────────────────────────────
// Logging must never slow the service down or fill the disk.
export const OUTPUT = Object.freeze({
    batchBytes: 4096,              // writes are batched up to this size …
    flushIntervalMs: 1000,         // … and flushed at least this often (so tails stay live)
    maxBufferBytes: 16 * 1024 * 1024, // a stalled disk drops records past this instead of growing memory
    dailyCapLevelBelow: 40,        // past a file's daily cap, records below warn are dropped
});

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
// In-process: the main thread hands its levels to worker threads (BroadcastChannel).
export const THREAD_LEVELS_CHANNEL = 'callio:log-levels:threads';
