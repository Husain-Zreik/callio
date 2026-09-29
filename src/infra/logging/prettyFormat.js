// src/infra/logging/prettyFormat.js
// One record (the JSON pino writes) as a readable line — the terminal in
// development and `npm run logs`:
//
//   2026-09-29 08:24:51.697 INFO  w2 channels.sip.SipIngress  call=9 tenant=103  INVITE accepted
//       {"providerCallId":"a84b…","did":"+96170000999"}
//       Error: … (stack)
import { BASE_FIELDS, CONTEXT_FIELDS, LEVEL_NAMES } from './policy.js';

const COLORS = { trace: 90, debug: 36, info: 32, warn: 33, error: 31, fatal: 35 };
const CONTEXT_LABELS = { callId: 'call', tenantId: 'tenant', agentId: 'agent', requestId: 'req' };
const HEAD = new Set([...BASE_FIELDS, ...CONTEXT_FIELDS, 'err', 'hostname', 'v']);

export function levelName(level) {
    return typeof level === 'number' ? (LEVEL_NAMES[level] ?? String(level)) : String(level).toLowerCase();
}

function time(t) {
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? String(t ?? '') : d.toISOString().replace('T', ' ').replace('Z', '');
}

const paint = (on, code, text) => (on ? `\x1b[${code}m${text}\x1b[0m` : text);

/**
 * @param {object} rec    a parsed log record
 * @param {object} opts   { colors: boolean }
 */
export function formatRecord(rec, { colors = false } = {}) {
    const lvl = levelName(rec.level);
    const context = CONTEXT_FIELDS.filter((k) => rec[k] != null).map((k) => `${CONTEXT_LABELS[k] ?? k}=${rec[k]}`).join(' ');
    const worker = rec.worker != null ? `w${rec.worker}${rec.thread != null ? `/t${rec.thread}` : ''}` : null;
    const where = [worker, rec.component, rec.mod].filter(Boolean).join(' ');
    let line = `${time(rec.time)} ${paint(colors, COLORS[lvl] ?? 0, lvl.toUpperCase().padEnd(5))} ${paint(colors, 90, where)}`
        + `${context ? `  ${paint(colors, 34, context)}` : ''}  ${rec.msg ?? ''}`;

    const details = Object.fromEntries(Object.entries(rec).filter(([k]) => !HEAD.has(k)));
    if (Object.keys(details).length) line += `\n    ${paint(colors, 90, JSON.stringify(details))}`;
    if (rec.err) {
        const e = rec.err;
        const text = (e.stack ?? `${e.type ?? 'Error'}: ${e.message ?? JSON.stringify(e)}`).replace(/\n\s*/g, '\n      ');
        line += `\n    ${paint(colors, 31, text)}`;
    }
    return line;
}
