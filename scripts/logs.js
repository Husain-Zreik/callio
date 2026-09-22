// scripts/logs.js
//
// Merges the per-worker log files written by AppLogService
// (logs/app/worker-{id}/YYYY-MM-DD.log.log + .error.log) into a single,
// timestamp-ordered stream so you don't have to open N files by hand to see
// what happened across all workers.
//
// Usage:
//   node scripts/logs.js                    combined log for today, all workers
//   node scripts/logs.js 2026-08-19         combined log for a specific date
//   node scripts/logs.js --errors           errors-only file instead of all-levels
//   node scripts/logs.js --worker=1,3       limit to specific worker ids
//   node scripts/logs.js --tail=200         only the last 200 merged lines
//   node scripts/logs.js --follow           live tail, combined, across workers —
//                                            starts empty, only shows lines written
//                                            AFTER the command starts (no backlog dump,
//                                            important with many workers)
//   node scripts/logs.js --follow --tail=50 same, but also prints the last 50 merged
//                                            lines as backdrop before going live
//   node scripts/logs.js --follow --errors  live tail of errors only
//
// npm shortcuts (see package.json): npm run logs / logs:follow / logs:errors

import fs   from 'fs';
import path from 'path';

const LOG_BASE = path.resolve(new URL('../logs/app', import.meta.url).pathname
    .replace(/^\/([A-Z]:)/, '$1'));

const TS_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\]/;

const WORKER_COLORS = [36, 35, 33, 32, 34, 91, 92, 93]; // cyan, magenta, yellow, green, blue, ...
const color = (code, text) => `\x1b[${code}m${text}\x1b[0m`;

function parseArgs(argv) {
    const opts = { errors: false, follow: false, workers: null, date: null, tail: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--errors' || arg === '-e') opts.errors = true;
        else if (arg === '--follow' || arg === '-f') opts.follow = true;
        else if (arg.startsWith('--worker=')) {
            opts.workers = new Set(arg.slice('--worker='.length).split(',').map(s => s.trim()));
        } else if (arg.startsWith('--tail=')) {
            opts.tail = parseInt(arg.slice('--tail='.length), 10);
        } else if (arg === '--tail' || arg === '-n') {
            opts.tail = parseInt(argv[++i], 10);
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
            opts.date = arg;
        }
    }
    if (!opts.date) opts.date = new Date().toISOString().slice(0, 10);
    if (!Number.isFinite(opts.tail) || opts.tail < 0) opts.tail = null;
    return opts;
}

function discoverWorkers(filter) {
    if (!fs.existsSync(LOG_BASE)) return [];
    return fs.readdirSync(LOG_BASE)
        .map(name => /^worker-(\d+)$/.exec(name))
        .filter(Boolean)
        .map(m => ({ id: m[1], dir: path.join(LOG_BASE, `worker-${m[1]}`) }))
        .filter(w => !filter || filter.has(w.id))
        .sort((a, b) => Number(a.id) - Number(b.id));
}

// The all-levels file is written as "{date}.log.log" (AppLogService names the
// stream "log", then appends ".log" itself). Fall back to "{date}.log" so this
// keeps working if that gets tidied up later.
function resolveFile(dir, date, errors) {
    if (errors) return path.join(dir, `${date}.error.log`);
    const doubled = path.join(dir, `${date}.log.log`);
    if (fs.existsSync(doubled)) return doubled;
    return path.join(dir, `${date}.log`);
}

// Reads a log file and groups it into timestamped records — a line without
// a leading timestamp (e.g. a stack trace continuation) is folded into the
// previous record rather than treated as its own out-of-order entry.
function readRecords(file, workerId) {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const records = [];
    let current = null;
    for (const line of lines) {
        const m = TS_RE.exec(line);
        if (m) {
            current = { ts: m[1], workerId, text: line };
            records.push(current);
        } else if (current && line.length) {
            current.text += `\n${line}`;
        }
    }
    return records;
}

function sortRecords(records) {
    return records.sort((a, b) => a.ts.localeCompare(b.ts) || Number(a.workerId) - Number(b.workerId));
}

// ── Historical merge ─────────────────────────────────────────────────────────

function printMerged(opts) {
    const workers = discoverWorkers(opts.workers);
    if (!workers.length) {
        console.error(`No worker log directories found under ${LOG_BASE}`);
        process.exit(1);
    }

    let records = [];
    for (const w of workers) {
        const file = resolveFile(w.dir, opts.date, opts.errors);
        // Bound per-worker before the global sort so a huge single-worker
        // file can't force reading everything into a giant merge just to
        // throw most of it away — only relevant once --tail is set.
        // concat, not push(...array) — a day's file can hold 100k+ lines,
        // which blows the call stack when spread as individual arguments.
        const workerRecords = readRecords(file, w.id);
        records = records.concat(opts.tail ? workerRecords.slice(-opts.tail) : workerRecords);
    }

    if (!records.length) {
        console.log(`No log entries found for ${opts.date}${opts.errors ? ' (errors)' : ''}.`);
        return;
    }

    sortRecords(records);
    if (opts.tail) records = records.slice(-opts.tail);
    for (const r of records) {
        console.log(formatLine(r.workerId, r.text));
    }
}

function formatLine(workerId, text) {
    const c = WORKER_COLORS[(Number(workerId) - 1) % WORKER_COLORS.length];
    const tag = color(c, `[worker-${workerId}]`);
    return `${tag} ${text}`;
}

// ── Live follow ──────────────────────────────────────────────────────────────

function followMerged(opts) {
    const workers = discoverWorkers(opts.workers);
    if (!workers.length) {
        console.error(`No worker log directories found under ${LOG_BASE}`);
        process.exit(1);
    }

    console.log(`Following combined ${opts.errors ? 'error' : 'app'} logs for worker(s): ${workers.map(w => w.id).join(', ')} (ctrl-c to stop)\n`);

    const state = new Map(); // workerId -> { file, offset, partial }
    const bootDay = new Date().toISOString().slice(0, 10);

    // Prime every worker's read offset to end-of-file *before* the interval
    // starts, so by default nothing already in the file gets printed — only
    // lines written from this point on. With --tail=N, print the last N
    // merged lines as backdrop first, but the offset still lands at EOF
    // either way so nothing is double-printed once the live loop takes over.
    if (opts.tail) {
        let backlog = [];
        for (const w of workers) {
            const file = resolveFile(w.dir, bootDay, opts.errors);
            const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
            state.set(w.id, { file, offset: size, partial: '' });
            backlog = backlog.concat(readRecords(file, w.id).slice(-opts.tail));
        }
        sortRecords(backlog);
        for (const r of backlog.slice(-opts.tail)) {
            console.log(formatLine(r.workerId, r.text));
        }
    } else {
        for (const w of workers) {
            const file = resolveFile(w.dir, bootDay, opts.errors);
            const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
            state.set(w.id, { file, offset: size, partial: '' });
        }
    }

    const tick = () => {
        const today = new Date().toISOString().slice(0, 10);
        for (const w of workers) {
            const file = resolveFile(w.dir, today, opts.errors);
            let s = state.get(w.id);

            if (!s || s.file !== file) {
                s = { file, offset: 0, partial: '' };
                state.set(w.id, s);
            }
            if (!fs.existsSync(file)) continue;

            const size = fs.statSync(file).size;
            if (size < s.offset) s.offset = 0; // file truncated/rotated
            if (size === s.offset) continue;

            const fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(size - s.offset);
            fs.readSync(fd, buf, 0, buf.length, s.offset);
            fs.closeSync(fd);
            s.offset = size;

            const chunk = s.partial + buf.toString('utf8');
            const lines = chunk.split('\n');
            s.partial = lines.pop(); // last piece may be incomplete

            for (const line of lines) {
                if (line.length) console.log(formatLine(w.id, line));
            }
        }
    };

    setInterval(tick, 500);
}

// ── Entry ─────────────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));
if (opts.follow) followMerged(opts);
else printMerged(opts);
