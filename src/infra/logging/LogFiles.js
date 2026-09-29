// src/infra/logging/LogFiles.js
// Per-worker, per-day log files, one JSON record per line:
//
//   storage/logs/app/worker-1/2026-09-29.log         every record the logger lets through
//   storage/logs/app/worker-1/2026-09-29.error.log   error and fatal only, for triage
//
// Files roll over at midnight (UTC); files older than the retention are
// deleted at startup. `npm run logs` reads, merges and filters them.
import fs from 'fs';
import path from 'path';
import pino from 'pino';

const today = () => new Date().toISOString().slice(0, 10);

// A pino destination (asynchronous, buffered) that rolls over by day.
class DailyFile {
    constructor(dir, suffix) {
        this.dir = dir;
        this.suffix = suffix;
        this.day = null;
        this.dest = null;
    }

    #open() {
        const day = today();
        if (this.dest && this.day === day) return;
        this.dest?.end();
        this.day = day;
        this.dest = pino.destination({ dest: path.join(this.dir, `${day}${this.suffix}`), append: true, mkdir: true, sync: false });
        this.dest.on('error', (err) => process.stderr.write(`[logging] cannot write ${this.suffix}: ${err.message}\n`));
    }

    write(chunk) {
        this.#open();
        return this.dest.write(chunk);
    }

    // Before the process exits: nothing buffered may be lost.
    flushSync() {
        try { this.dest?.flushSync(); } catch { /* not open yet, or already closed */ }
    }

    end() {
        this.flushSync();
        this.dest?.end();
        this.dest = null;
    }
}

export function logDirFor(baseDir, workerId) {
    return path.join(baseDir, `worker-${workerId}`);
}

export function openLogFiles({ baseDir, workerId, retentionDays, prune = true }) {
    const dir = logDirFor(baseDir, workerId);
    fs.mkdirSync(dir, { recursive: true });

    if (prune) try {
        const cutoff = Date.now() - retentionDays * 86_400_000;
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
        }
    } catch { /* pruning is best effort */ }

    return { all: new DailyFile(dir, '.log'), errors: new DailyFile(dir, '.error.log'), dir };
}
