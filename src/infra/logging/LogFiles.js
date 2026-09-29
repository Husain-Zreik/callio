// src/infra/logging/LogFiles.js
// Per-worker, per-day log files, one JSON record per line:
//
//   storage/logs/app/worker-1/2026-09-29.log         every record the logger lets through
//   storage/logs/app/worker-1/2026-09-29.error.log   error and fatal only, for triage
//
// Built so logging can't slow the service or fill the disk (policy.OUTPUT):
// writes are asynchronous and batched; a stalled disk drops records past a
// bounded buffer instead of growing memory; past the daily cap only warn and
// above are kept. Drops are counted and reported (takeDrops). Files roll over
// at midnight UTC; files older than the retention are deleted at startup.
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { OUTPUT } from './policy.js';

const today = () => new Date().toISOString().slice(0, 10);
const LEVEL_AT_START = /^\{"level":(\d+)/;

class DailyFile {
    constructor(dir, suffix, capBytes) {
        this.dir = dir;
        this.suffix = suffix;
        this.capBytes = capBytes;
        this.day = null;
        this.dest = null;
        this.bytes = 0;
        this.capNoticed = false;
        this.drops = { buffer: 0, cap: 0 };
    }

    #open() {
        const day = today();
        if (this.dest && this.day === day) return;
        this.dest?.end();
        this.day = day;
        const file = path.join(this.dir, `${day}${this.suffix}`);
        try { this.bytes = fs.statSync(file).size; } catch { this.bytes = 0; }
        this.capNoticed = false;
        // The file is opened synchronously (ready at once — a crash right after
        // start still reaches it); writes stay asynchronous.
        this.dest = pino.destination({
            fd: fs.openSync(file, 'a'), sync: false,
            minLength: OUTPUT.batchBytes, maxLength: OUTPUT.maxBufferBytes, periodicFlush: OUTPUT.flushIntervalMs,
        });
        this.dest.on('drop', () => { this.drops.buffer++; });
        this.dest.on('error', (err) => process.stderr.write(`[logging] cannot write ${file}: ${err.message}\n`));
    }

    write(chunk) {
        this.#open();
        if (this.capBytes && this.bytes >= this.capBytes) {
            const level = Number(LEVEL_AT_START.exec(chunk)?.[1] ?? 50);
            if (level < OUTPUT.dailyCapLevelBelow) { this.drops.cap++; return true; }
            if (!this.capNoticed) {
                this.capNoticed = true;
                this.dest.write(`${JSON.stringify({ level: 40, time: new Date().toISOString(), component: 'infra.logging',
                    msg: 'Daily log cap reached — keeping warn and above until midnight UTC', capBytes: this.capBytes })}\n`);
            }
        }
        this.bytes += chunk.length;
        return this.dest.write(chunk);
    }

    /** Records dropped since the last call. */
    takeDrops() {
        const d = this.drops;
        this.drops = { buffer: 0, cap: 0 };
        return d;
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

export function openLogFiles({ baseDir, workerId, retentionDays, prune = true, dailyCapBytes = 0 }) {
    const dir = path.join(baseDir, `worker-${workerId}`);
    fs.mkdirSync(dir, { recursive: true });

    if (prune) try {
        const cutoff = Date.now() - retentionDays * 86_400_000;
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
        }
    } catch { /* pruning is best effort */ }

    return { all: new DailyFile(dir, '.log', dailyCapBytes), errors: new DailyFile(dir, '.error.log', 0), dir };
}
