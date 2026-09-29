// src/infra/logging/prettyFormat.js
// One log record (the JSON object pino writes) as a readable line — used for
// the terminal in development and by `npm run logs`.
//
//   2026-09-29 08:24:51.697 INFO  w2 channels.sip SipIngress  call=9 tenant=103  INVITE to +96170000999
//     { source: "92.204.163.211" }
//     Error: … (stack)

const LEVEL_NAMES = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const COLORS = { TRACE: 90, DEBUG: 36, INFO: 32, WARN: 33, ERROR: 31, FATAL: 35 };
// Fields shown in the line's head (not repeated in the details).
const HEAD = new Set(['time', 'level', 'msg', 'worker', 'thread', 'pid', 'component', 'mod', 'hostname', 'err',
    'callId', 'tenantId', 'agentId', 'requestId', 'v']);
const CONTEXT = [['callId', 'call'], ['tenantId', 'tenant'], ['agentId', 'agent'], ['requestId', 'req']];

export function levelName(level) {
    return typeof level === 'number' ? (LEVEL_NAMES[level] ?? String(level)) : String(level).toUpperCase();
}

function time(t) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? String(t ?? '') : d.toISOString().replace('T', ' ').replace('Z', '');
}

function color(on, code, text) {
    return on ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/**
 * @param {object} rec    a parsed log record
 * @param {object} opts   { colors: boolean }
 */
export function formatRecord(rec, { colors = false } = {}) {
    const lvl = levelName(rec.level);
    const context = CONTEXT.filter(([k]) => rec[k] != null).map(([k, label]) => `${label}=${rec[k]}`).join(' ');
    const where = [rec.worker != null ? `w${rec.worker}${rec.thread != null ? `/t${rec.thread}` : ''}` : null, rec.component, rec.mod].filter(Boolean).join(' ');
    let line = `${time(rec.time)} ${color(colors, COLORS[lvl] ?? 0, lvl.padEnd(5))} ${color(colors, 90, where)}`
        + `${context ? `  ${color(colors, 34, context)}` : ''}  ${rec.msg ?? ''}`;

    const details = Object.fromEntries(Object.entries(rec).filter(([k]) => !HEAD.has(k)));
    if (Object.keys(details).length) line += `\n    ${color(colors, 90, JSON.stringify(details))}`;
    if (rec.err) {
        const e = rec.err;
        const text = (e.stack ?? `${e.type ?? 'Error'}: ${e.message ?? JSON.stringify(e)}`).replace(/\n\s*/g, '\n      ');
        line += `\n    ${color(colors, 31, text)}`;
    }
    return line;
}
