// preload.cjs — loaded via --require before any ESM module evaluation.
// Catches crashes that happen before the logger (src/infra/logging/logger.js) initializes and writes them
// to the worker's dated error log — the same file the rest of the app uses.
'use strict';

const fs = require('fs');
const path = require('path');

function logStartupCrash(err) {
    const workerId = process.env.WORKER_ID ?? '0';
    const now = new Date();
    const date = now.toISOString().split('T')[0];

    const logFile = path.join(
        __dirname, 'storage', 'logs', 'app', `worker-${workerId}`,
        `${date}.error.log`
    );

    // Same JSON record shape as the logger, so `npm run logs` shows it.
    const msg = JSON.stringify({
        level: 60, time: now.toISOString(), worker: workerId, pid: process.pid, component: 'process',
        err: { type: err?.name ?? 'Error', message: String(err?.message ?? err), stack: err?.stack },
        msg: 'crashed before the logger initialized',
    }) + '\n';

    try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
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
