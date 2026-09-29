// src/infra/logging/logger.js
// The logging API — the only logging module the rest of src/ imports.
//
//   import { logger } from '../../infra/logging/logger.js';
//   const log = logger('channels.sip.SipIngress');     // <layer>.<area>.<File>
//   log.info({ callId, providerCallId }, 'INVITE accepted');
//   log.warn({ callId, err }, 'rtpengine offer failed');
//
// Fields first (names from policy.FIELDS), then a short message: no ids in
// the text, no [Prefix], no emojis; errors as { err }.
//
// The pieces, one job each:
//   policy.js        levels, field names, redaction keys, PII fields — the rules
//   levels.js        which level each component logs at (LOG_LEVEL / LOG_LEVELS / runtime)
//   context.js       fields bound to a flow (callId, tenantId, agentId, requestId)
//   redaction.js     secrets redacted always, PII masked when LOG_MASK_PII=true
//   destinations.js  files, stdout
//   throttle.js      one record per window for repeating events
//   consoleBridge.js console.* from libraries
//   LogLevelControl  runtime level changes over Redis (npm run log-level)
import { isMainThread, threadId } from 'worker_threads';
import pino from 'pino';
import { config } from '../../../config/envConfig.js';
import { COMPONENTS } from './policy.js';
import { LevelRegistry } from './levels.js';
import { currentLogContext } from './context.js';
import { maskingHook, redactOptions } from './redaction.js';
import { destination, flushDestinations, initDestinations } from './destinations.js';
import { installConsoleBridge as bridgeConsole } from './consoleBridge.js';

export { runWithLogContext, withLogContext, addLogContext } from './context.js';
export { throttle } from './throttle.js';
export { maskPii } from './redaction.js';

const settings = config.logging;
const registry = new LevelRegistry({ level: settings.level, levels: settings.levels });

const root = pino({
    level: 'trace',   // components carry the real levels (registry)
    base: { worker: config.runtime.workerId, pid: process.pid, ...(isMainThread ? {} : { thread: threadId }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
    redact: redactOptions,
    formatters: { level: (label, number) => ({ level: number }) },
    mixin: currentLogContext,
    hooks: settings.maskPii ? { logMethod: maskingHook } : {},
}, destination);

const components = new Map();

/** The logger for a component (cached; its level follows LOG_LEVELS and runtime changes). */
export function logger(component) {
    let log = components.get(component);
    if (!log) {
        log = root.child({ component });
        registry.track(component, log);
        components.set(component, log);
    }
    return log;
}

// ── Levels ──────────────────────────────────────────────────────────────────

/** Apply { level?, levels? } on this worker (over the current state). */
export const setLogLevels = (override) => registry.apply(override);
/** Back to LOG_LEVEL / LOG_LEVELS. */
export const resetLogLevels = () => registry.reset();
export const currentLogLevels = () => registry.snapshot();
export const knownComponents = () => registry.components();

// ── Lifecycle ───────────────────────────────────────────────────────────────

/** Open the server's outputs (files, stdout). Called by serverLogging.js; worker threads call it themselves. */
export function initLogging() {
    const opened = initDestinations({
        dir: settings.dir, workerId: config.runtime.workerId, retentionDays: settings.retentionDays,
        prune: isMainThread, stdout: settings.stdout, format: settings.format, stdoutLevel: settings.stdoutLevel,
    });
    if (opened && isMainThread) {
        const { level, levels } = registry.snapshot();
        logger(COMPONENTS.process).info({ node: process.version, defaultLevel: level, levels }, 'worker starting');
    }
}

/** console.* from libraries into the logger. */
export function installConsoleBridge() {
    bridgeConsole({ consoleLog: logger(COMPONENTS.console), processLog: logger(COMPONENTS.process) });
}

/** Write out everything buffered (before process.exit). */
export const flushLogs = flushDestinations;
process.on('exit', flushLogs);

// Worker threads belong to a server process.
if (!isMainThread) initLogging();
