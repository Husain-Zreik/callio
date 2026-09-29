// src/infra/logging/logger.js
// The one logger. Every module logs through a component logger:
//
//   import { logger } from '../../infra/logging/logger.js';
//   const log = logger('channels.sip.ingress');
//   log.info({ callId, from }, 'INVITE accepted');
//   log.warn({ err, callId }, 'rtpengine offer failed');
//
// Records are JSON (pino), one per line, in per-worker daily files
// (LogFiles.js) and optionally on stdout (json or pretty).
//
// Components are dotted paths — layer first (core.routing.queue-timeout,
// media.webrtc.peer, channels.whatsapp.api …) — and levels are set per
// subtree: LOG_LEVEL is the default, LOG_LEVELS overrides branches
// ("media=warn,channels.sip=debug"); the longest matching prefix wins.
// Levels can be changed at runtime on every worker (LogLevelControl.js).
//
// Context: fields bound with runWithLogContext()/withLogContext() (callId,
// tenantId, agentId, requestId) are added to every record logged inside
// that async flow, so a call's records can be pulled out with
// `npm run logs -- --call 42` without each line naming it.
//
// Secrets are always redacted (REDACT_KEYS). Phone numbers and SIP users are
// masked only when LOG_MASK_PII=true.
//
// Worker threads (DTMF detection, Opus encoding) get their own instance that
// appends to the same files, with a `thread` field.
import { AsyncLocalStorage } from 'async_hooks';
import { format } from 'util';
import { isMainThread, threadId } from 'worker_threads';
import pino from 'pino';
import { config } from '../../../config/envConfig.js';
import { openLogFiles } from './LogFiles.js';
import { formatRecord } from './prettyFormat.js';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
const settings = config.logging;

// ── Redaction and masking ────────────────────────────────────────────────────

const REDACT_KEYS = ['token', 'accessToken', 'access_token', 'apiKey', 'api_key', 'secret', 'appSecret', 'password',
    'authorization', 'Authorization', 'cookie', 'credential', 'credentials', 'privateKey', 'private_key',
    'signingKey', 'signing_key', 'masterKey', 'jwt'];
const REDACT_PATHS = [
    ...REDACT_KEYS.flatMap((k) => [k, `*.${k}`]),
    'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]', 'headers["x-api-key"]',
    'req.headers["x-hub-signature-256"]',
];

// Field names whose values are a customer's address (phone number / SIP URI).
const PII_FIELDS = new Set(['from', 'to', 'phone', 'phoneNumber', 'phone_number', 'caller', 'callee', 'msisdn',
    'customerAddress', 'customer_address', 'address', 'displayPhoneNumber', 'display_phone_number', 'did', 'number']);

function maskDigits(s) {
    return s.length <= 4 ? '***' : `${s.slice(0, s.startsWith('+') ? 4 : 3)}${'*'.repeat(Math.max(3, s.length - 7))}${s.slice(-3)}`;
}

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
        if (typeof v === 'string') out[k] = PII_FIELDS.has(k) ? maskDigits(v.replace(/^sips?:/i, '')) : maskPii(v);
        else if (typeof v === 'number' && PII_FIELDS.has(k)) out[k] = maskDigits(String(v));
        else out[k] = maskFields(v, depth + 1);
    }
    return out;
}

// ── Context ──────────────────────────────────────────────────────────────────

const context = new AsyncLocalStorage();

/** Run fn with these fields added to every record logged inside it (and anything it awaits). */
export function withLogContext(fields, fn) {
    return context.run({ ...(context.getStore() ?? {}), ...clean(fields) }, fn);
}

/** Run fn with only these fields as context (an HTTP request, a socket event: nothing inherited from elsewhere). */
export function runWithLogContext(fields, fn) {
    return context.run(clean(fields), fn);
}

/** Add fields for the rest of the current flow (inside withLogContext/runWithLogContext; siblings are unaffected). */
export function addLogContext(fields) {
    const store = context.getStore();
    if (store) context.enterWith({ ...store, ...clean(fields) });
}

function clean(fields) {
    return Object.fromEntries(Object.entries(fields ?? {}).filter(([, v]) => v !== undefined && v !== null));
}

// ── Destinations ─────────────────────────────────────────────────────────────

// Until initLogging() runs (the server's index.js; worker threads do it
// themselves), records go to stderr only — so a CLI script that imports core
// modules keeps a clean stdout and leaves no log files behind.
let files = null;

const terminal = {
    mode: 'cli',   // 'cli' (stderr, readable) | 'pretty' | 'json' (stdout) | 'off'
    write(line) {
        if (this.mode === 'off') return true;
        if (this.mode === 'json') return process.stdout.write(line);
        const out = this.mode === 'cli' ? process.stderr : process.stdout;
        try { out.write(`${formatRecord(JSON.parse(line), { colors: Boolean(out.isTTY) })}
`); }
        catch { out.write(line); }
        return true;
    },
};

const destination = pino.multistream([{ level: 'trace', stream: terminal }], { dedupe: false });

// ── Root and component loggers ───────────────────────────────────────────────

const root = pino({
    level: 'trace',                                   // components carry the real levels
    base: { worker: config.runtime.workerId, pid: process.pid, ...(isMainThread ? {} : { thread: threadId }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: { level: (label, number) => ({ level: number }) },
    mixin: () => context.getStore() ?? {},
    hooks: settings.maskPii ? {
        logMethod(args, method) {
            method.apply(this, args.map((a) => (typeof a === 'string' ? maskPii(a) : maskFields(a))));
        },
    } : {},
}, destination);

function parseLevels(spec) {
    const out = {};
    for (const part of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
        const [name, level] = part.split('=').map((s) => s.trim());
        if (name && LEVELS.includes(level)) out[name] = level;
    }
    return out;
}

const configured = { level: LEVELS.includes(settings.level) ? settings.level : 'info', levels: parseLevels(settings.levels) };
let active = { level: configured.level, levels: { ...configured.levels } };
const components = new Map();   // component -> pino child

export function levelFor(component) {
    let best = null;
    for (const name of Object.keys(active.levels)) {
        if ((component === name || component.startsWith(`${name}.`)) && (!best || name.length > best.length)) best = name;
    }
    return best ? active.levels[best] : active.level;
}

/** The logger for a component (cached; its level follows runtime changes). */
export function logger(component) {
    let log = components.get(component);
    if (!log) {
        log = root.child({ component }, { level: levelFor(component) });
        components.set(component, log);
    }
    return log;
}

// ── Runtime level control ────────────────────────────────────────────────────

/** Apply { level?, levels? } on this worker. levels merge over the current ones; a level of 'default' removes an override. */
export function setLogLevels({ level, levels } = {}) {
    if (level && LEVELS.includes(level)) active.level = level;
    for (const [name, lvl] of Object.entries(levels ?? {})) {
        if (lvl === 'default' || lvl == null) delete active.levels[name];
        else if (LEVELS.includes(lvl)) active.levels[name] = lvl;
    }
    for (const [name, log] of components) log.level = levelFor(name);
}

/** Back to what .env configured. */
export function resetLogLevels() {
    active = { level: configured.level, levels: { ...configured.levels } };
    for (const [name, log] of components) log.level = levelFor(name);
}

export function currentLogLevels() {
    return { level: active.level, levels: { ...active.levels }, configured: { level: configured.level, levels: { ...configured.levels } } };
}

export function knownComponents() {
    return [...components.keys()].sort();
}

// ── Repeats ──────────────────────────────────────────────────────────────────

const throttles = new Map();   // key -> { until, suppressed }

/**
 * For events that can repeat many times a second (scanner INVITEs, a peer's
 * failing retries): returns null while inside the window after the last
 * logged occurrence, else the number suppressed since then (log it as
 * `{ repeated }`).
 *   const repeated = throttle(`sip-404:${ip}`, 60_000);
 *   if (repeated !== null) log.warn({ ip, repeated }, 'INVITE for an unknown number');
 */
export function throttle(key, windowMs) {
    const now = Date.now();
    const t = throttles.get(key);
    if (t && now < t.until) { t.suppressed++; return null; }
    const suppressed = t?.suppressed ?? 0;
    throttles.set(key, { until: now + windowMs, suppressed: 0 });
    if (throttles.size > 5000) for (const [k, v] of throttles) if (v.until < now) throttles.delete(k);
    return suppressed;
}

// ── Console bridge and process hooks ─────────────────────────────────────────

let bridged = false;

/**
 * Routes console.* (third-party libraries, anything not converted yet) into
 * the logger as component "console", taking a leading "[Prefix]" as `mod`.
 */
export function installConsoleBridge() {
    if (bridged) return;
    bridged = true;
    const log = logger('console');
    const processLog = logger('process');
    const bridge = (level) => (...args) => {
        const err = args.find((a) => a instanceof Error);
        let text = format(...args.filter((a) => a !== err));
        const m = /^\s*\[([^\]]{1,60})\]\s*/.exec(text);
        const fields = {};
        if (m) { fields.mod = m[1]; text = text.slice(m[0].length); }
        if (err) fields.err = err;
        // Node's own process warnings (deprecations, …) arrive through console.error.
        if (/^\(node:\d+\) /.test(text)) return processLog.warn(fields, text.replace(/^\(node:\d+\) /, ''));
        log[level](fields, text);
    };
    console.log = bridge('info');
    console.info = bridge('info');
    console.debug = bridge('debug');
    console.trace = bridge('trace');
    console.warn = bridge('warn');
    console.error = bridge('error');
}

/**
 * The server's logging: per-worker daily JSON files (all + errors) and stdout
 * per LOG_STDOUT / LOG_FORMAT. Idempotent.
 */
export function initLogging() {
    if (files) return;
    files = openLogFiles({ baseDir: settings.dir, workerId: config.runtime.workerId, retentionDays: settings.retentionDays, prune: isMainThread });
    destination.add({ level: 'trace', stream: files.all });
    destination.add({ level: 'error', stream: files.errors });
    terminal.mode = settings.stdout ? (settings.format === 'json' ? 'json' : 'pretty') : 'off';
    if (isMainThread) logger('process').info({ node: process.version, defaultLevel: active.level, levels: active.levels }, 'worker starting');
}

/** Write out everything buffered (before process.exit). */
export function flushLogs() {
    files?.all.flushSync();
    files?.errors.flushSync();
}

process.on('exit', flushLogs);

// Worker threads belong to a server process.
if (!isMainThread) initLogging();
