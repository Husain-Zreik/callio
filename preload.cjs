// preload.cjs — loaded via --require before any ESM module evaluation.
// Catches crashes that happen before AppLogService initializes and writes them
// to the worker's dated error log — the same file the rest of the app uses.
'use strict';

const fs = require('fs');
const path = require('path');

function logStartupCrash(err) {
    const workerId = process.env.WORKER_ID ?? '0';
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const ts = now.toISOString().replace('T', ' ').slice(0, 23);

    const logFile = path.join(
        __dirname, 'logs', 'app', `worker-${workerId}`,
        `${date}.error.log`
    );

    const msg = `[${ts}] [FATAL]  [Startup] Process crashed before logger initialized: ${err?.stack ?? err}\n`;

    try {
        fs.appendFileSync(logFile, msg);
    } catch {
        process.stderr.write(msg);
    }
}

process.on('uncaughtException', (err) => { logStartupCrash(err); process.exit(1); });
process.on('unhandledRejection', (reason) => {
    logStartupCrash(reason instanceof Error ? reason : new Error(String(reason)));
    process.exit(1);
});
