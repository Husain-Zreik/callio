// src/infra/logging/destinations.js
// Where records go.
//
// Until initDestinations() runs (the server's serverLogging.js; worker threads
// do it themselves) records go to stderr only, readable, so a CLI script that
// imports core modules keeps a clean stdout and leaves no log files behind.
// After it:
//   files    storage/logs/app/worker-N/YYYY-MM-DD.log        every record (LogFiles.js)
//            storage/logs/app/worker-N/YYYY-MM-DD.error.log  error and fatal
//   stdout   only when LOG_STDOUT is on: LOG_FORMAT pretty|json, from LOG_STDOUT_LEVEL up
// An output that is off is not in the chain at all (no per-record cost).
import pino from 'pino';
import { openLogFiles } from './LogFiles.js';
import { formatRecord } from './prettyFormat.js';
import { LEVEL_VALUES } from './policy.js';

const readable = (out) => ({
    write(line) {
        try { out.write(`${formatRecord(JSON.parse(line), { colors: Boolean(out.isTTY) })}\n`); }
        catch { out.write(line); }
        return true;
    },
});

/** The pino destination: one multistream; outputs join and leave it. */
export const destination = pino.multistream([{ level: 'trace', stream: readable(process.stderr) }], { dedupe: false });
const cliStreamId = destination.lastId;

let files = null;

/** Open the server's outputs (idempotent). Returns false if they were already open. */
export function initDestinations({ dir, workerId, retentionDays, prune, stdout, format, stdoutLevel, dailyCapBytes }) {
    if (files) return false;
    files = openLogFiles({ baseDir: dir, workerId, retentionDays, prune, dailyCapBytes });
    destination.add({ level: 'trace', stream: files.all });
    destination.add({ level: 'error', stream: files.errors });
    destination.remove(cliStreamId);
    if (stdout) {
        destination.add({
            level: LEVEL_VALUES[stdoutLevel] ?? LEVEL_VALUES.trace,
            stream: format === 'json' ? process.stdout : readable(process.stdout),
        });
    }
    return true;
}

/** Records dropped since the last call (full buffer on a stalled disk, daily cap). */
export function takeDrops() {
    if (!files) return { buffer: 0, cap: 0 };
    const a = files.all.takeDrops();
    const e = files.errors.takeDrops();
    return { buffer: a.buffer + e.buffer, cap: a.cap + e.cap };
}

/** Write out everything buffered (before process.exit). */
export function flushDestinations() {
    files?.all.flushSync();
    files?.errors.flushSync();
}
