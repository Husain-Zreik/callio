// scripts/logs.js
// Reads the per-worker JSON log files (storage/logs/app/worker-N/YYYY-MM-DD.log,
// .error.log), merges them in time order, filters, and prints readable lines
// (or JSON with --json). Old text-format files are read too.
//
//   npm run logs -- [date] [options]
//
// Which levels
//   --level warn             warn and above (the usual)
//   --level info..warn       a range: info and warn
//   --level debug,error      exactly these
//   --errors, -e             the error files (error + fatal) — fastest for triage
//
// Which records
//   --call 42                one call: callId, callUuid or providerCallId
//   --tenant 103 --agent 110 --worker 1,2
//   --component channels.sip records whose component starts with this (comma = several)
//   --where queueId=3        any field equals a value (repeatable; err.message=… for nested)
//   --grep rtpengine         case-insensitive regex over the whole record
//   --since 15m              the last 30s / 15m / 2h / 1d
//
// Output
//   --follow, -f             live: records written from now on (add --tail N for backdrop)
//   --tail N, -n N           only the last N matching records
//   --json                   JSON lines (for jq)
//   --stats                  counts per level and component instead of records
//
// Records exist only for levels the components were logging at when they were
// written (LOG_LEVEL / LOG_LEVELS / npm run log-level): to read debug for
// channels.sip later, enable it first.
import fs from 'fs';
import path from 'path';
import { formatRecord, levelName } from '../src/infra/logging/prettyFormat.js';
import { LEVELS, LEVEL_VALUES } from '../src/infra/logging/policy.js';

const LOG_BASE = path.resolve(new URL('../storage/logs/app', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const LEGACY_LINE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\] \[(\w+)\s*\]\s{1,2}(.*)$/;

function fail(message) {
    console.error(message);
    process.exit(2);
}

// "warn" -> warn and above; "info..warn" -> range; "debug,error" -> exactly those.
function parseLevels(spec) {
    const value = (name) => LEVEL_VALUES[name.trim().toLowerCase()] ?? fail(`Unknown level "${name}" (${LEVELS.join(', ')})`);
    const s = String(spec);
    if (s.includes('..')) {
        const [lo, hi] = s.split('..').map(value);
        return new Set(Object.values(LEVEL_VALUES).filter((v) => v >= Math.min(lo, hi) && v <= Math.max(lo, hi)));
    }
    if (s.includes(',')) return new Set(s.split(',').map(value));
    const min = value(s);
    return new Set(Object.values(LEVEL_VALUES).filter((v) => v >= min));
}

function parseSince(v) {
    const m = /^(\d+)([smhd])$/.exec(String(v));
    if (!m) fail(`--since takes e.g. 30s, 15m, 2h, 1d (got ${v})`);
    return Date.now() - Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
}

function parseArgs(argv) {
    const o = { errors: false, follow: false, json: false, stats: false, workers: null, date: null, tail: null,
        levels: null, components: null, call: null, tenant: null, agent: null, where: [], grep: null, since: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
        const value = () => inline ?? argv[++i] ?? fail(`${name} needs a value`);
        switch (name) {
            case '--errors': case '-e': o.errors = true; break;
            case '--follow': case '-f': o.follow = true; break;
            case '--json': o.json = true; break;
            case '--stats': o.stats = true; break;
            case '--worker': o.workers = new Set(value().split(',').map((s) => s.trim())); break;
            case '--tail': case '-n': o.tail = parseInt(value(), 10); break;
            case '--level': case '-l': o.levels = parseLevels(value()); break;
            case '--component': case '-c': o.components = value().split(',').map((s) => s.trim()).filter(Boolean); break;
            case '--call': o.call = value(); break;
            case '--tenant': o.tenant = value(); break;
            case '--agent': o.agent = value(); break;
            case '--where': case '-w': {
                const w = value(); const eq = w.indexOf('=');
                if (eq < 1) fail(`--where takes field=value (got ${w})`);
                o.where.push([w.slice(0, eq).split('.'), w.slice(eq + 1)]);
                break;
            }
            case '--grep': case '-g': o.grep = new RegExp(value(), 'i'); break;
            case '--since': o.since = parseSince(value()); break;
            default:
                if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) o.date = arg;
                else fail(`Unknown option: ${arg} (see the header of scripts/logs.js)`);
        }
    }
    if (!o.date) o.date = new Date().toISOString().slice(0, 10);
    if (!Number.isFinite(o.tail) || o.tail < 0) o.tail = null;
    return o;
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
    const current = path.join(dir, `${date}.log`);
    const legacy = path.join(dir, `${date}.log.log`);   // the old text logger's name
    return fs.existsSync(current) || !fs.existsSync(legacy) ? current : legacy;
}

// A JSON record, or a line of the old text format read as one.
function parseLine(line, workerId) {
    if (line.startsWith('{')) {
        try { return JSON.parse(line); } catch { /* fall through */ }
    }
    const m = LEGACY_LINE.exec(line);
    return m ? { time: `${m[1].replace(' ', 'T')}Z`, level: LEVEL_VALUES[m[2].toLowerCase()] ?? 30, worker: workerId, msg: m[3] } : null;
}

// Lines that are neither (old multi-line stack traces) join the record before them.
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

const fieldAt = (rec, keys) => keys.reduce((v, k) => (v == null ? v : v[k]), rec);
const levelOf = (rec) => (typeof rec.level === 'number' ? rec.level : LEVEL_VALUES[String(rec.level).toLowerCase()] ?? 30);

function matches(rec, o) {
    if (o.levels && !o.levels.has(levelOf(rec))) return false;
    if (o.since && Date.parse(rec.time) < o.since) return false;
    if (o.components && !o.components.some((c) => rec.component === c || String(rec.component ?? '').startsWith(`${c}.`))) return false;
    if (o.call && ![rec.callId, rec.callUuid, rec.providerCallId].some((v) => v != null && String(v) === o.call)) return false;
    if (o.tenant && String(rec.tenantId) !== o.tenant) return false;
    if (o.agent && String(rec.agentId) !== o.agent) return false;
    if (o.where.some(([keys, v]) => String(fieldAt(rec, keys)) !== v)) return false;
    if (o.grep && !o.grep.test(JSON.stringify(rec))) return false;
    return true;
}

const colors = Boolean(process.stdout.isTTY);
const print = (rec, o) => console.log(o.json ? JSON.stringify(rec) : formatRecord(rec, { colors }));
const byTime = (a, b) => String(a.time).localeCompare(String(b.time));

function printStats(records) {
    const byComponent = new Map();
    const totals = {};
    for (const r of records) {
        const lvl = levelName(levelOf(r));
        const c = r.component ?? '(none)';
        if (!byComponent.has(c)) byComponent.set(c, {});
        byComponent.get(c)[lvl] = (byComponent.get(c)[lvl] ?? 0) + 1;
        totals[lvl] = (totals[lvl] ?? 0) + 1;
    }
    const cols = LEVELS.filter((l) => totals[l]);
    const width = Math.max(9, ...[...byComponent.keys()].map((c) => c.length));
    console.log(`${'component'.padEnd(width)}  ${cols.map((l) => l.padStart(7)).join('')}`);
    for (const [c, counts] of [...byComponent].sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`${c.padEnd(width)}  ${cols.map((l) => String(counts[l] ?? '').padStart(7)).join('')}`);
    }
    console.log(`${'total'.padEnd(width)}  ${cols.map((l) => String(totals[l]).padStart(7)).join('')}`);
}

function printMerged(o) {
    const workers = discoverWorkers(o.workers);
    if (!workers.length) fail(`No worker log directories under ${LOG_BASE}`);
    let records = [];
    for (const w of workers) {
        // concat, not push(...): a day's file can hold 100k+ records.
        records = records.concat(readRecords(resolveFile(w.dir, o.date, o.errors), w.id).filter((r) => matches(r, o)));
    }
    if (!records.length) return console.log(`No matching records for ${o.date}${o.errors ? ' (errors)' : ''}.`);
    records.sort(byTime);
    if (o.stats) return printStats(records);
    for (const r of o.tail ? records.slice(-o.tail) : records) print(r, o);
}

function followMerged(o) {
    const workers = discoverWorkers(o.workers);
    if (!workers.length) fail(`No worker log directories under ${LOG_BASE}`);
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
