// scripts/logs.js
//
// Reads the per-worker JSON log files (storage/logs/app/worker-{id}/YYYY-MM-DD.log
// and .error.log), merges them in time order, filters, and prints them as
// readable lines (or raw JSON with --json).
//
// Usage (npm run logs -- <options>):
//   (no options)             today, all workers
//   2026-09-28               another day
//   --follow, -f             live: only records written from now on (add --tail N for a backdrop)
//   --tail N, -n N           the last N matching records
//   --errors, -e             the error files only (error + fatal)
//   --level warn             this level and above (trace|debug|info|warn|error|fatal)
//   --component channels.sip records whose component starts with this (comma-separate several)
//   --call 42                one call (callId, or callUuid / provider call id)
//   --tenant 103 / --agent 110 / --worker 1,2
//   --grep "rtpengine"       case-insensitive regex over the message and fields
//   --since 15m              only the last 15m / 2h / 1d
//   --json                   print the matching records as JSON lines (for jq)
//
// npm shortcuts: npm run logs / logs:follow / logs:errors
import fs from 'fs';
import path from 'path';
import { formatRecord } from '../src/infra/logging/prettyFormat.js';

const LOG_BASE = path.resolve(new URL('../storage/logs/app', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const LEVEL_VALUES = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const LEGACY_LINE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \[(\w+)\s*\]\s{1,2}(.*)$/;

function parseArgs(argv) {
    const o = { errors: false, follow: false, json: false, workers: null, date: null, tail: null, minLevel: 0,
        components: null, call: null, tenant: null, agent: null, grep: null, since: null };
    const value = (i, arg) => (arg.includes('=') ? [arg.slice(arg.indexOf('=') + 1), i] : [argv[i + 1], i + 1]);
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const name = arg.split('=')[0];
        let v;
        switch (name) {
            case '--errors': case '-e': o.errors = true; break;
            case '--follow': case '-f': o.follow = true; break;
            case '--json': o.json = true; break;
            case '--worker': [v, i] = value(i, arg); o.workers = new Set(String(v).split(',').map((s) => s.trim())); break;
            case '--tail': case '-n': [v, i] = value(i, arg); o.tail = parseInt(v, 10); break;
            case '--level': [v, i] = value(i, arg); o.minLevel = LEVEL_VALUES[String(v).toLowerCase()] ?? 0; break;
            case '--component': case '-c': [v, i] = value(i, arg); o.components = String(v).split(',').map((s) => s.trim()).filter(Boolean); break;
            case '--call': [v, i] = value(i, arg); o.call = String(v); break;
            case '--tenant': [v, i] = value(i, arg); o.tenant = String(v); break;
            case '--agent': [v, i] = value(i, arg); o.agent = String(v); break;
            case '--grep': case '-g': [v, i] = value(i, arg); o.grep = new RegExp(v, 'i'); break;
            case '--since': [v, i] = value(i, arg); o.since = parseSince(v); break;
            default:
                if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) o.date = arg;
                else { console.error(`Unknown option: ${arg}`); process.exit(2); }
        }
    }
    if (!o.date) o.date = new Date().toISOString().slice(0, 10);
    if (!Number.isFinite(o.tail) || o.tail < 0) o.tail = null;
    return o;
}

function parseSince(v) {
    const m = /^(\d+)([smhd])$/.exec(String(v));
    if (!m) { console.error(`--since takes e.g. 30s, 15m, 2h, 1d (got ${v})`); process.exit(2); }
    return Date.now() - Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
}

function discoverWorkers(filter) {
    if (!fs.existsSync(LOG_BASE)) return [];
    return fs.readdirSync(LOG_BASE)
        .map((name) => /^worker-(.+)$/.exec(name))
        .filter(Boolean)
        .map((m) => ({ id: m[1], dir: path.join(LOG_BASE, `worker-${m[1]}`) }))
        .filter((w) => !filter || filter.has(w.id))
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

function resolveFile(dir, date, errors) {
    if (errors) return path.join(dir, `${date}.error.log`);
    const legacy = path.join(dir, `${date}.log.log`);   // the old text logger's name
    const current = path.join(dir, `${date}.log`);
    return fs.existsSync(current) || !fs.existsSync(legacy) ? current : legacy;
}

// A JSON record, or a line from the old text format read as one.
function parseLine(line, workerId) {
    if (line.startsWith('{')) {
        try { return JSON.parse(line); } catch { /* fall through */ }
    }
    const m = LEGACY_LINE.exec(line);
    if (m) return { time: `${m[1].replace(' ', 'T')}Z`, level: LEVEL_VALUES[m[2].toLowerCase()] ?? 30, worker: workerId, msg: m[3] };
    return null;
}

// Lines that are neither JSON nor a legacy record (old stack traces) join the record before them.
function readRecords(file, workerId) {
    if (!fs.existsSync(file)) return [];
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        const rec = parseLine(line, workerId);
        if (rec) out.push(rec);
        else if (out.length) out[out.length - 1].msg += `\n${line}`;
    }
    return out;
}

function matches(rec, o) {
    const lvl = typeof rec.level === 'number' ? rec.level : LEVEL_VALUES[String(rec.level).toLowerCase()] ?? 30;
    if (lvl < o.minLevel) return false;
    if (o.since && Date.parse(rec.time) < o.since) return false;
    if (o.components && !o.components.some((c) => rec.component === c || String(rec.component ?? '').startsWith(`${c}.`))) return false;
    if (o.call && ![rec.callId, rec.callUuid, rec.providerCallId].some((v) => v != null && String(v) === o.call)) return false;
    if (o.tenant && String(rec.tenantId) !== o.tenant) return false;
    if (o.agent && String(rec.agentId) !== o.agent) return false;
    if (o.grep && !o.grep.test(JSON.stringify(rec))) return false;
    return true;
}

const colors = Boolean(process.stdout.isTTY);
const print = (rec, o) => console.log(o.json ? JSON.stringify(rec) : formatRecord(rec, { colors }));
const byTime = (a, b) => String(a.time).localeCompare(String(b.time));

function printMerged(o) {
    const workers = discoverWorkers(o.workers);
    if (!workers.length) { console.error(`No worker log directories under ${LOG_BASE}`); process.exit(1); }

    let records = [];
    for (const w of workers) {
        // concat, not push(...): a day's file can hold 100k+ records.
        records = records.concat(readRecords(resolveFile(w.dir, o.date, o.errors), w.id).filter((r) => matches(r, o)));
    }
    if (!records.length) { console.log(`No matching log records for ${o.date}${o.errors ? ' (errors)' : ''}.`); return; }
    records.sort(byTime);
    for (const r of o.tail ? records.slice(-o.tail) : records) print(r, o);
}

function followMerged(o) {
    const workers = discoverWorkers(o.workers);
    if (!workers.length) { console.error(`No worker log directories under ${LOG_BASE}`); process.exit(1); }
    console.error(`Following ${o.errors ? 'error' : 'all'} logs for worker(s) ${workers.map((w) => w.id).join(', ')} (ctrl-c to stop)`);

    const state = new Map();   // workerId -> { file, offset, partial }
    const day = new Date().toISOString().slice(0, 10);
    let backlog = [];
    for (const w of workers) {
        const file = resolveFile(w.dir, day, o.errors);
        state.set(w.id, { file, offset: fs.existsSync(file) ? fs.statSync(file).size : 0, partial: '' });
        if (o.tail) backlog = backlog.concat(readRecords(file, w.id).filter((r) => matches(r, o)));
    }
    if (o.tail) for (const r of backlog.sort(byTime).slice(-o.tail)) print(r, o);

    setInterval(() => {
        const today = new Date().toISOString().slice(0, 10);
        for (const w of workers) {
            const file = resolveFile(w.dir, today, o.errors);
            let s = state.get(w.id);
            if (s.file !== file) { s = { file, offset: 0, partial: '' }; state.set(w.id, s); }
            if (!fs.existsSync(file)) continue;
            const size = fs.statSync(file).size;
            if (size < s.offset) s.offset = 0;
            if (size === s.offset) continue;

            const fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(size - s.offset);
            fs.readSync(fd, buf, 0, buf.length, s.offset);
            fs.closeSync(fd);
            s.offset = size;

            const lines = (s.partial + buf.toString('utf8')).split('\n');
            s.partial = lines.pop();
            for (const line of lines) {
                const rec = line && parseLine(line, w.id);
                if (rec && matches(rec, o)) print(rec, o);
            }
        }
    }, 500);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.follow) followMerged(opts);
else printMerged(opts);
