// ── PM2 process configuration ──────────────────────────────────────────────────
//
// Worker count and port range are read from .env so the same file works on
// every server without modification:
//
//   WORKER_COUNT=2        # dev / small server
//   WORKER_COUNT=16       # production
//   BASE_PORT=3001        # first worker port (workers claim 3001, 3002, ...)
//
// Other tunable env vars (with their defaults):
//   NODE_ENV=production        # 'development' | 'staging' | 'production'
//   UV_THREADPOOL_SIZE=16
//   WORKER_MEMORY_LIMIT=1G
//   WORKER_KILL_TIMEOUT=5000   (ms — must exceed shutdown() force-exit of 60 s
//                                if graceful S3 upload drain is needed; keep at
//                                5000 only when recordings are disabled or short)
//
// AppLogService owns all application logging → logs/app/worker-{id}/YYYY-MM-DD.*
// PM2's own out_file / error_file are sent to /dev/null to avoid duplicate flat
// files — the only output PM2 captures is the startup/shutdown banner that passes
// through before AppLogService installs itself, which is negligible.

// ── Why dotenv.config() is called here ────────────────────────────────────────
// The rule in this codebase is: never read process.env directly — always go
// through config/envConfig.js.  This file is the one explicit exception.
//
// ecosystem.config.cjs is PM2 launch infrastructure: it runs before the Node.js
// app process exists, so it cannot import the ESM envConfig module.  The
// dotenv.config() call here is deliberately minimal — it only reads the handful
// of PM2-tuning variables listed below.  All application-level env vars are
// still handled exclusively by config/envConfig.js inside each worker.
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const NODE_ENV      =          process.env.NODE_ENV               || 'production';
const WORKER_COUNT  = parseInt(process.env.WORKER_COUNT           || '2',    10);
const BASE_PORT     = parseInt(process.env.BASE_PORT              || '3001', 10);
const MEMORY_LIMIT  =          process.env.WORKER_MEMORY_LIMIT    || '1G';
const THREAD_POOL   =          process.env.UV_THREADPOOL_SIZE      || '16';
const KILL_TIMEOUT  = parseInt(process.env.WORKER_KILL_TIMEOUT    || '5000', 10);
// Identifies this app/server so `pm2 ls` / `pm2 monit` stay readable when
// multiple servers are watched from one PM2 dashboard (e.g. pm2-plus).
const APP_NAME      =          process.env.APP_NAME                || 'app';

module.exports = {
    apps: Array.from({ length: WORKER_COUNT }, (_, i) => ({
        name: `${APP_NAME}_worker_${i + 1}`,
        script: './index.js',
        exec_mode: 'fork',
        instances: 1,
        env: {
            NODE_ENV,
            PORT: BASE_PORT + i,
            WORKER_ID: i + 1,
            UV_THREADPOOL_SIZE: THREAD_POOL,
            NODE_OPTIONS: `--require ${__dirname}/preload.cjs`,
        },
        out_file: '/dev/null',
        error_file: '/dev/null',
        autorestart: true,
        max_memory_restart: MEMORY_LIMIT,
        max_restarts: 10,
        min_uptime: '10s',
        kill_timeout: KILL_TIMEOUT,
    })),
};
