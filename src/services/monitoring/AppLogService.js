// src/services/monitoring/AppLogService.js
//
// Replaces the two accumulating PM2 log files with per-worker, per-day files:
//
//   logs/app/worker-1/2026-05-18.log        ← all levels (info, warn, error)
//   logs/app/worker-1/2026-05-18.error.log  ← errors only, quick triage
//
// Call AppLogService.install() FIRST in index.js, before any other import
// that might log, so every line gets captured.
//
// Each line format:
//   [2026-05-18 14:32:00.123] [WARN]   message text here
//
// Files older than RETENTION_DAYS are deleted on install() to keep disk clean.

import fs   from 'fs';
import path from 'path';
import { config } from '../../../config/envConfig.js';

const RETENTION_DAYS = 14;

// Resolve logs/app relative to the project root (three directories above this file).
const LOG_BASE = path.resolve(
    new URL('../../../logs/app', import.meta.url).pathname
        .replace(/^\/([A-Z]:)/, '$1')   // strip leading slash on Windows paths
);

class AppLogService {
    constructor() {
        this._workerId   = config.runtime?.workerId ?? process.env.WORKER_ID ?? 'unknown';
        this._workerDir  = path.join(LOG_BASE, `worker-${this._workerId}`);

        // Active write streams keyed by type ('all' | 'error')
        this._streams    = {};
        this._streamDay  = null;

        // Keep originals so we can still write to PM2 / terminal
        this._origLog    = null;
        this._origError  = null;
        this._installed  = false;
    }

    // ── One-time setup ────────────────────────────────────────────────────────

    install() {
        if (this._installed) return;
        this._installed = true;

        this._ensureDirs();
        this._pruneOldFiles();
        this._openStreams();

        // Save originals
        this._origLog   = console.log.bind(console);
        this._origError = console.error.bind(console);
        const self      = this;

        // Redirect every console method
        console.log   = (...a) => self._write('INFO',  a);
        console.info  = (...a) => self._write('INFO',  a);
        console.debug = (...a) => self._write('DEBUG', a);
        console.warn  = (...a) => self._write('WARN',  a);
        console.error = (...a) => self._write('ERROR', a);

        // Write a startup banner so each day's file shows when the worker booted
        console.log(`━━━ Worker ${this._workerId} started (pid ${process.pid}) ━━━`);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _write(level, args) {
        // Rotate at midnight
        this._openStreams();

        const text = args
            .map(a => (typeof a === 'object' ? this._stringify(a) : String(a)))
            .join(' ');

        const ts   = new Date();
        const line = `[${this._ts(ts)}] [${level.padEnd(5)}]  ${text}\n`;

        // Write to the all-levels file
        this._streams.all?.write(line);

        // Errors also go to the error-only file for quick triage
        if (level === 'ERROR') this._streams.error?.write(line);

        // Pass through to original stdout/stderr so PM2 backup and terminal work
        if (level === 'ERROR') {
            this._origError?.(text);
        } else {
            this._origLog?.(text);
        }
    }

    _stringify(obj) {
        try   { return JSON.stringify(obj, null, 0); }
        catch { return String(obj); }
    }

    _ts(d) {
        return (
            d.toISOString()
             .replace('T', ' ')
             .replace('Z', '')
             .slice(0, 23)          // YYYY-MM-DD HH:MM:SS.mmm
        );
    }

    _today() {
        return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    }

    _ensureDirs() {
        if (!fs.existsSync(LOG_BASE))         fs.mkdirSync(LOG_BASE,        { recursive: true });
        if (!fs.existsSync(this._workerDir))  fs.mkdirSync(this._workerDir, { recursive: true });
    }

    _openStreams() {
        const day = this._today();
        if (this._streamDay === day && this._streams.all) return; // still correct day

        this._closeStreams();
        this._streamDay = day;

        const open = (name) => {
            const p = path.join(this._workerDir, `${day}.${name}.log`);
            const s = fs.createWriteStream(p, { flags: 'a' });
            s.on('error', (err) => this._origError?.(`[AppLog] stream error: ${err.message}`));
            return s;
        };

        this._streams = {
            all:   open('log'),
            error: open('error'),
        };
    }

    _closeStreams() {
        for (const s of Object.values(this._streams)) {
            try { s?.end(); } catch { /* best effort */ }
        }
        this._streams  = {};
        this._streamDay = null;
    }

    _pruneOldFiles() {
        try {
            const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
            for (const name of fs.readdirSync(this._workerDir)) {
                const full = path.join(this._workerDir, name);
                if (fs.statSync(full).mtimeMs < cutoff) {
                    fs.unlinkSync(full);
                }
            }
        } catch { /* non-fatal */ }
    }
}

export const appLogService = new AppLogService();
