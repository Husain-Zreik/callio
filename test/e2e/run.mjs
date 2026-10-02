// End-to-end test runner (npm run test:e2e). Creates a fresh test database,
// migrates and seeds it, starts Callio against a fake Meta Graph API, runs
// every *.test.mjs suite with a clean call state, and stops Callio.
//
// Needs MySQL 8 and Redis reachable — `docker compose -f test/e2e/docker-compose.yml up -d`
// gives both on the default ports below. Override with TEST_DB_* / TEST_REDIS_*.
// And the media plane — `docker compose -f deploy/sip-gateway/docker-compose.local.yml
// up -d --build` (drachtio, rtpengine, FreeSWITCH): every call's media runs there.
import { spawn, spawnSync } from 'child_process';
import net from 'net';
import http from 'http';
import dgram from 'dgram';
import dns from 'dns/promises';
import { createRequire } from 'module';
import { randomBytes } from 'crypto';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir, networkInterfaces } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { fakeS3 } from './lib.mjs';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const Redis = require('ioredis');

// One run at a time: every run recreates the same database and uses the same
// ports, so two at once break each other. The lock is a listening port, so
// the OS frees it however this process ends (crash, kill). A second run waits.
const LOCK_PORT = Number(process.env.TEST_LOCK_PORT || 3899);
const lock = net.createServer();
for (let waited = 0; ; waited++) {
    const taken = await new Promise((resolve) => {
        lock.once('error', (err) => resolve(err.code === 'EADDRINUSE'));
        lock.listen(LOCK_PORT, '127.0.0.1', () => resolve(false));
    });
    if (!taken) break;
    if (waited === 0) console.log(`[e2e] another test run is in progress (port ${LOCK_PORT}) — waiting for it to finish`);
    if (waited >= 180) { console.log('[e2e] gave up waiting after 15 minutes'); process.exit(1); }
    await new Promise((r) => setTimeout(r, 5000));
}
lock.unref();

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const work = mkdtempSync(join(tmpdir(), 'callio-e2e-'));
const port = Number(process.env.TEST_CALLIO_PORT || 3901);
const S3_PORT = Number(process.env.TEST_S3_PORT || 3995);

// Every suite needs the media plane (deploy/sip-gateway/docker-compose.local.yml).
const listening = (port) => new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
});
if (!await listening(9022) || !await listening(8021)) {
    console.log('[e2e] the media plane is not running (drachtio :9022, FreeSWITCH :8021) — '
        + 'docker compose -f deploy/sip-gateway/docker-compose.local.yml up -d --build');
    process.exit(1);
}
const rtpengineAnswers = () => new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const cookie = `preflight${Date.now()}${randomBytes(4).toString('hex')}`;
    const done = (ok) => { clearTimeout(t); s.close(); resolve(ok); };
    const t = setTimeout(() => done(false), 1500);
    s.on('message', (m) => done(m.toString().startsWith(`${cookie} `)));
    s.send(`${cookie} d7:command4:pinge`, 22222, '127.0.0.1');
});
if (!await rtpengineAnswers()) {
    console.log('[e2e] rtpengine does not answer on :22222 — '
        + 'docker compose -f deploy/sip-gateway/docker-compose.local.yml up -d --build');
    process.exit(1);
}
// The media server runs in Docker: it reaches this machine (Callio's audio
// route and event-socket callbacks, the fake S3) as host.docker.internal.
// Callio, on this machine, uses the same name, through the hosts file Docker
// Desktop writes — which keeps an old address after the network changes, and
// then everything that uses it (object storage first) hangs. So check it.
async function dockerHost() {
    if (process.env.TEST_DOCKER_HOST) return process.env.TEST_DOCKER_HOST;
    const own = Object.values(networkInterfaces()).flat().filter((a) => a?.family === 'IPv4');
    const resolved = await dns.lookup('host.docker.internal', { family: 4 }).then((r) => r.address, () => null);
    if (resolved && own.some((a) => a.address === resolved)) return 'host.docker.internal';
    // This machine's LAN address: the one in the stale address's /24 if any,
    // else the first that isn't loopback or a Docker/WSL/Hyper-V bridge (172.16/12).
    const lan = own.filter((a) => !a.internal && !/^172\.(1[6-9]|2\d|3[01])\./.test(a.address));
    const prefix = resolved?.split('.').slice(0, 3).join('.');
    const pick = lan.find((a) => a.address.startsWith(`${prefix}.`)) ?? lan[0];
    if (!pick) {
        console.log(`[e2e] host.docker.internal is ${resolved ?? 'unresolvable'}, not an address of this machine, and no LAN address was found — set TEST_DOCKER_HOST`);
        process.exit(1);
    }
    console.log(`[e2e] host.docker.internal is ${resolved ?? 'unresolvable'}, not an address of this machine `
        + `(stale hosts entry — restarting Docker Desktop rewrites it); using ${pick.address}`);
    return pick.address;
}
const DOCKER_HOST = await dockerHost();
const mediaEnv = {
    DRACHTIO_HOST: '127.0.0.1', DRACHTIO_PORT: '9022', DRACHTIO_SECRET: process.env.TEST_DRACHTIO_SECRET || 'CHANGE_ME',
    RTPENGINE_HOST: '127.0.0.1', RTPENGINE_NG_PORT: '22222',
    FREESWITCH_HOST: '127.0.0.1', FREESWITCH_ESL_PORT: '8021', FREESWITCH_ESL_PASSWORD: process.env.TEST_FREESWITCH_PASSWORD || 'CHANGE_ME',
    MEDIA_ESL_ADVERTISED_ADDRESS: DOCKER_HOST,
    // A sweep every second: one lands in any window where a live call's legs
    // look orphaned (a call being handed over), instead of every 30 s by luck.
    MEDIA_ORPHAN_SWEEP_SECONDS: '1',
};

const env = {
    ...process.env,
    DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
    DB_PORT: process.env.TEST_DB_PORT || '33306',
    DB_USERNAME: process.env.TEST_DB_USERNAME || 'root',
    DB_PASSWORD: process.env.TEST_DB_PASSWORD || 'callio',
    DB_DATABASE: process.env.TEST_DB_DATABASE || 'callio_test',
    REDIS_HOST: process.env.TEST_REDIS_HOST || '127.0.0.1',
    REDIS_PORT: process.env.TEST_REDIS_PORT || '36379',
    REDIS_DB: process.env.TEST_REDIS_DB || '15',
    NODE_HOST: '0.0.0.0',   // the media server fetches audio from Callio
    NODE_PORT: String(port),
    WORKER_ID: 'e2e',
    WHATSAPP_API_URL: 'http://127.0.0.1:3990/',
    STORAGE_LOCAL_ROOT: join(work, 'storage'),
    CALLIO_MASTER_KEY: randomBytes(32).toString('base64'),
    // Keep real provider credentials out of the test process. Object storage is
    // the fake S3 below, so recordings upload and can be read back.
    AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_BUCKET: 'callio-test', AWS_DEFAULT_REGION: 'us-east-1',
    // The media server uploads recordings there too.
    AWS_ENDPOINT: `http://${DOCKER_HOST}:${S3_PORT}`, AWS_USE_PATH_STYLE_ENDPOINT: 'true', AWS_BUCKET_PREFIX: '', AWS_URL: '',
    ONESIGNAL_APP_ID: '', APNS_KEY_ID: '',
    ONESIGNAL_API_URL: 'http://127.0.0.1:3998/notifications',   // push.test.mjs's fake OneSignal
    FIREBASE_SERVICE_ACCOUNT_PATH: join(work, 'no-firebase.json'),
    // Each suite's Callio output (pretty, debug) lands in <work>/<suite>.callio.log.
    LOG_LEVEL: process.env.TEST_LOG_LEVEL || 'debug', LOG_STDOUT: 'true', LOG_FORMAT: 'pretty',
    CALL_TRANSFER_TIMEOUT_SECONDS: '6',
    WEBHOOK_ALLOW_HTTP: 'true',      // the suites' receivers are http://127.0.0.1
    RETENTION_SWEEP_SECONDS: '10',   // retention.test.mjs: a sweep every ~10 s
    ...mediaEnv,
};

const run = (args, opts = {}) => {
    const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', ...opts });
    if (r.status !== 0) throw new Error(`${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
};

async function resetState() {
    const db = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USERNAME, password: env.DB_PASSWORD, database: env.DB_DATABASE });
    await db.query('SET FOREIGN_KEY_CHECKS=0');
    for (const t of ['webhook_deliveries', 'call_recordings', 'ivr_session_inputs', 'ivr_sessions', 'call_transfer_logs',
        'call_lifecycle_events', 'call_participants', 'call_connections', 'calls']) await db.query(`TRUNCATE ${t}`);
    await db.query('SET FOREIGN_KEY_CHECKS=1');
    await db.query("UPDATE agents SET availability = 'OFFLINE'");
    await db.query("UPDATE ivr_flows SET status = 'INACTIVE'");   // a suite's flow must not catch the next suite's calls
    await db.end();
    const redis = new Redis({ host: env.REDIS_HOST, port: Number(env.REDIS_PORT), db: Number(env.REDIS_DB) });
    await redis.flushdb();
    redis.disconnect();
}

async function startCallio(logFile, workerPort = port, workerId = 'e2e') {
    const { openSync } = await import('fs');
    const out = openSync(logFile, 'w');
    const child = spawn(process.execPath, ['index.js'], { cwd: root, env: { ...env, NODE_PORT: String(workerPort), WORKER_ID: workerId }, stdio: ['ignore', out, out, 'ipc'] });
    child.port = workerPort;
    child.workerId = workerId;
    child.logFile = logFile;
    for (let i = 0; i < 120; i++) {   // up to 60 s: a cold first start (native modules, AV scanning) can be slow
        try {
            const res = await fetch(`http://127.0.0.1:${workerPort}/health`);
            if (res.ok && (await res.json()).media?.connected) return child;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 500));
    }
    child.kill();
    throw new Error(`Callio did not start — see ${logFile}`);
}

// A suite asks for several workers (as PM2 runs them) with a first line
// `// e2e-workers: N`; it gets them in E2E_WORKERS ([{ port, pid }]) and may kill one.
function workersFor(suite) {
    const first = readFileSync(join(here, suite), 'utf8').split('\n', 1)[0];
    return Number(/^\/\/ e2e-workers: (\d+)/.exec(first)?.[1] ?? 1);
}
// A suite asks for a worker's graceful shutdown (as PM2 does on Windows, by
// IPC message): POST <E2E_CONTROL_URL>/workers/<index>/shutdown.
const CONTROL_PORT = Number(process.env.TEST_CONTROL_PORT || 3898);
// POST <E2E_CONTROL_URL>/workers/restart restarts them all, as `pm2 restart`
// does: each stopped gracefully, then a fresh process on the same port.
const control = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/workers/restart') {
        const old = callios.splice(0);
        await Promise.all(old.map((c) => new Promise((resolve) => {
            if (c.exitCode !== null || c.signalCode !== null) return resolve();
            c.once('exit', resolve);
            c.send('shutdown');
        })));
        try {
            for (const c of old) callios.push(await startCallio(`${c.logFile}.restarted`, c.port, c.workerId));
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(callios.map((c) => ({ port: c.port, pid: c.pid }))));
        } catch (err) {
            res.writeHead(500).end(err.message);
        }
        return;
    }
    const m = /^\/workers\/(\d+)\/shutdown$/.exec(req.url);
    const child = m && callios[Number(m[1])];
    if (req.method !== 'POST' || !child) { res.writeHead(404).end(); return; }
    child.send('shutdown');
    res.writeHead(202).end();
});
await new Promise((resolve) => control.listen(CONTROL_PORT, '127.0.0.1', resolve));
control.unref();

const stopCallio = (child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
});

function suiteFiles() {
    const only = process.argv.slice(2);
    const all = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();
    return only.length ? all.filter((f) => only.some((o) => f.includes(o))) : all;
}

// The logging rules (CLAUDE.md, Logging), checked on every run: code in src/
// logs through src/infra/logging/logger.js, never console.*, and messages
// carry no "[Prefix]" or emoji (the component names the source).
const LOG_RULES = [
    [/\bconsole\s*(\.|\[)/, 'console.* — use the logger'],
    [/\blog\.(trace|debug|info|warn|error|fatal)\((\{[^}]*\},\s*)?['`]\[/, 'message starts with [Prefix] — the component names the source'],
    [/\blog\.(trace|debug|info|warn|error|fatal)\(.*\p{Extended_Pictographic}/u, 'emoji in a log message'],
];
function checkLogging() {
    const offenders = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) { if (full !== join(root, 'src', 'infra', 'logging')) walk(full); continue; }
            if (!/\.m?js$/.test(entry.name)) continue;
            readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
                const code = line.replace(/^\s*\/\/.*$/, '');
                for (const [rule, why] of LOG_RULES) {
                    if (rule.test(code)) offenders.push(`${full.slice(root.length + 1)}:${i + 1}: ${why}\n      ${line.trim()}`);
                }
            });
        }
    };
    walk(join(root, 'src'));
    if (offenders.length) {
        console.log(`[e2e] logging rules broken in src/:\n  ${offenders.join('\n  ')}`);
        process.exit(1);
    }
}
checkLogging();

// The logger's guarantees (context, redaction, levels, throttle) — loggingCheck.mjs.
{
    const r = spawnSync(process.execPath, [join(here, 'loggingCheck.mjs')], { cwd: root, encoding: 'utf8' });
    let results;
    try { results = JSON.parse(r.stdout); } catch { console.log(`[e2e] logging check crashed:\n${r.stdout}\n${r.stderr}`); process.exit(1); }
    const failedChecks = results.filter((c) => !c.ok);
    console.log(`[e2e] logging: ${results.length - failedChecks.length}/${results.length} checks passed`);
    for (const c of failedChecks) console.log(`FAIL  logging: ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    if (failedChecks.length) process.exit(1);
}

let failed = 0;
const callios = [];
const s3 = fakeS3({ bucket: 'callio-test', port: S3_PORT, host: '0.0.0.0' });
await s3.listen();
try {
    console.log(`[e2e] preparing database ${env.DB_DATABASE}`);
    const admin = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USERNAME, password: env.DB_PASSWORD });
    await admin.query(`DROP DATABASE IF EXISTS \`${env.DB_DATABASE}\``);
    await admin.query(`CREATE DATABASE \`${env.DB_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.end();

    run([join(root, 'node_modules/knex/bin/cli.js'), 'migrate:latest']);
    const seedOut = run(['scripts/seed-dev.js', '--phone-number-id', '111222333', '--whatsapp-token', 'fake-token',
        '--whatsapp-number', '+96170000000', '--webhook-url', 'http://127.0.0.1:3999/events',
        // The trunk points at the fake carrier (sipCarrier.mjs) as the gateway's containers see this machine.
        '--sip-did', '+96170000001', '--sip-trunk-host', 'host.docker.internal', '--sip-trunk-port', '5070']);
    const seedFile = join(work, 'seed.json');
    writeFileSync(seedFile, seedOut.slice(seedOut.indexOf('{')));

    for (const suite of suiteFiles()) {
        await resetState();
        const count = workersFor(suite);
        const logFiles = [];
        for (let i = 0; i < count; i++) {
            const logFile = join(work, i === 0 ? `${suite}.callio.log` : `${suite}.w${i + 1}.callio.log`);
            logFiles.push(logFile);
            callios.push(await startCallio(logFile, port + i, count > 1 ? `e2e-${i + 1}` : 'e2e'));
        }
        console.log(`\n[e2e] ── ${suite}${count > 1 ? ` (${count} workers)` : ''}`);
        const suiteEnv = { ...env, E2E_WORKERS: JSON.stringify(callios.map((c) => ({ port: c.port, pid: c.pid }))), E2E_CONTROL_URL: `http://127.0.0.1:${CONTROL_PORT}` };
        // Not spawnSync: the fake S3 in this process has to keep answering while the suite runs.
        const r = await new Promise((done) => spawn(process.execPath, [join(here, suite), seedFile, String(port)], { cwd: root, env: suiteEnv, stdio: 'inherit' })
            .on('exit', (status) => done({ status })));
        for (const c of callios.splice(0)) await stopCallio(c);
        const errors = logFiles.flatMap((f) => [f, `${f}.restarted`]).filter((f) => existsSync(f))
            .flatMap((f) => readFileSync(f, 'utf8').split('\n'))
            .filter((l) => /unhandled|exception|is not a function|unknown column|doesn't exist|AGENT STUCK/i.test(l));
        if (errors.length) console.log(`[e2e] Callio log problems (${logFiles.join(', ')}):\n  ${errors.slice(0, 20).join('\n  ')}`);
        if (r.status !== 0 || errors.length) failed++;
    }
} catch (err) {
    console.error('[e2e] setup failed:', err.message);
    failed++;
} finally {
    for (const c of callios) c.kill();
    s3.close();
}

console.log(`\n[e2e] ${failed ? `${failed} suite(s) failed` : 'all suites passed'} — logs in ${work}`);
process.exit(failed ? 1 : 0);
