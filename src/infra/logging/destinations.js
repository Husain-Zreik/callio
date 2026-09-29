// src/infra/logging/destinations.js
// Where records go.
//
// Until initDestinations() runs (the server's serverLogging.js; worker threads
// do it themselves) records go to stderr only, readable, so a CLI script that
// imports core modules keeps a clean stdout and leaves no log files behind.
// After it:
//   files    storage/logs/app/worker-N/YYYY-MM-DD.log        every record
//            storage/logs/app/worker-N/YYYY-MM-DD.error.log  error and fatal
//   stdout   LOG_STDOUT on/off, LOG_FORMAT pretty|json, LOG_STDOUT_LEVEL minimum
import pino from 'pino';
import { openLogFiles } from './LogFiles.js';
import { formatRecord } from './prettyFormat.js';
import { LEVEL_VALUES } from './policy.js';

const terminal = {
    mode: 'cli',     // 'cli' (stderr, readable) | 'pretty' | 'json' (stdout) | 'off'
    minLevel: 0,
    write(line) {
        if (this.mode === 'off') return true;
        let rec;
        try { rec = JSON.parse(line); } catch { return process.stderr.write(line); }
        if (rec.level < this.minLevel) return true;
        if (this.mode === 'json') return process.stdout.write(line);
        const out = this.mode === 'cli' ? process.stderr : process.stdout;
        return out.write(`${formatRecord(rec, { colors: Boolean(out.isTTY) })}\n`);
    },
};

/** The pino destination: one multistream that files join on init. */
export const destination = pino.multistream([{ level: 'trace', stream: terminal }], { dedupe: false });

let files = null;

/** Open the server's outputs (idempotent). Returns false if they were already open. */
export function initDestinations({ dir, workerId, retentionDays, prune, stdout, format, stdoutLevel }) {
    if (files) return false;
    files = openLogFiles({ baseDir: dir, workerId, retentionDays, prune });
    destination.add({ level: 'trace', stream: files.all });
    destination.add({ level: 'error', stream: files.errors });
    terminal.mode = stdout ? (format === 'json' ? 'json' : 'pretty') : 'off';
    terminal.minLevel = LEVEL_VALUES[stdoutLevel] ?? 0;
    return true;
}

/** Write out everything buffered (before process.exit). */
export function flushDestinations() {
    files?.all.flushSync();
    files?.errors.flushSync();
}
