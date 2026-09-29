// The logger's own guarantees, checked in a child process by run.mjs before
// the suites (node test/e2e/loggingCheck.mjs prints a JSON result on stdout).
import { Writable } from 'stream';
import { logger, runWithLogContext, setLogLevels, throttle } from '../../src/infra/logging/logger.js';
import { destination } from '../../src/infra/logging/destinations.js';

const records = [];
destination.add({ level: 'trace', stream: new Writable({ write(chunk, _enc, done) { records.push(JSON.parse(chunk)); done(); } }) });
const took = (fn) => { const from = records.length; fn(); return records.slice(from); };
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });

const log = logger('check.logging.Sample');

let r = took(() => runWithLogContext({ callId: 7 }, () => { log.info({ first: 1 }, 'one'); log.info('two'); }));
check('records carry a text level and service / env / host for log stores (Loki)',
    r[0]?.level === 'info' && r[0]?.service === 'callio' && typeof r[0]?.env === 'string' && typeof r[0]?.host === 'string', JSON.stringify(r[0]));
check('context fields reach every record in the flow', r.every((x) => x.callId === 7));
check("one record's fields do not leak into the next", r[1] && r[1].first === undefined, JSON.stringify(r[1]));

r = took(() => runWithLogContext({ callId: 8 }, () => {}) ?? log.info('outside'));
check('context does not outlive its flow', r[0] && r[0].callId === undefined, JSON.stringify(r[0]));

r = took(() => log.info({ token: 'abc', nested: { secret: 's' }, apiKey: 'k' }, 'secrets'));
check('secrets are redacted', r[0].token === '[redacted]' && r[0].nested.secret === '[redacted]' && r[0].apiKey === '[redacted]', JSON.stringify(r[0]));

r = took(() => log.info({ a: { b: { c: { password: 'p', ok: 1 } } }, Authorization: 'Bearer x' }, 'deep'));
check('secrets are redacted deep and case-insensitively', r[0].a.b.c.password === '[redacted]' && r[0].a.b.c.ok === 1 && r[0].Authorization === '[redacted]', JSON.stringify(r[0]));

const httpErr = Object.assign(new Error('Request failed with status code 400'), {
    isAxiosError: true, code: 'ERR_BAD_REQUEST',
    config: { method: 'post', url: 'https://graph.example/v21.0/1/calls?access_token=T', headers: { Authorization: 'Bearer SECRET' } },
    request: { _header: 'POST … Authorization: Bearer SECRET' },
    response: { status: 400, headers: {}, data: { error: { message: 'bad' }, token: 'T2' } },
});
r = took(() => log.error({ err: httpErr }, 'http failed'));
const line = JSON.stringify(r[0]);
check('HTTP-client errors keep method, url, status and body but no credentials',
    r[0].err.http?.status === 400 && r[0].err.http?.url === 'https://graph.example/v21.0/1/calls' && !/SECRET|access_token=|T2"/.test(line), line);

r = took(() => log.error({ err: new Error('boom') }, 'failed'));
check('errors keep type, message and stack', r[0].err?.message === 'boom' && /Error: boom/.test(r[0].err?.stack ?? ''));

r = took(() => { setLogLevels({ levels: { check: 'warn' } }); log.info('hidden'); log.warn('shown'); });
check('a prefix level applies to the components under it', r.length === 1 && r[0].msg === 'shown', JSON.stringify(r.map((x) => x.msg)));
r = took(() => { setLogLevels({ levels: { 'check.logging.Sample': 'debug' } }); log.debug('deeper'); });
check('the longest matching prefix wins', r.length === 1);

const seen = [throttle('k', 60_000), throttle('k', 60_000), throttle('k', 60_000)];
check('throttle lets the first through and counts the rest', seen[0] === 0 && seen[1] === null && seen[2] === null, JSON.stringify(seen));

{
    const { mkdtempSync, readFileSync, readdirSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { openLogFiles } = await import('../../src/infra/logging/LogFiles.js');
    const dir = mkdtempSync(join(tmpdir(), 'callio-logcap-'));
    const files = openLogFiles({ baseDir: dir, workerId: 'cap', retentionDays: 1, dailyCapBytes: 2000 });
    const rec = (level, i) => `${JSON.stringify({ level, time: new Date().toISOString(), msg: `record ${i}`, pad: 'x'.repeat(80) })}\n`;
    for (let i = 0; i < 100; i++) files.all.write(rec('info', i));
    files.all.write(rec('error', 'late error'));
    files.all.flushSync();
    const drops = files.all.takeDrops();
    const written = readFileSync(join(dir, 'worker-cap', readdirSync(join(dir, 'worker-cap'))[0]), 'utf8');
    check('past the daily cap info is dropped (and counted), errors are still written',
        drops.cap > 0 && written.includes('Daily log cap reached') && written.includes('late error') && written.length < 4000,
        `drops=${JSON.stringify(drops)} bytes=${written.length}`);
}

{
    const { spawnSync } = await import('child_process');
    const { mkdtempSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const run = spawnSync(process.execPath, [new URL('./loggingThreadCheck.mjs', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')], {
        encoding: 'utf8', env: { ...process.env, LOG_DIR: mkdtempSync(join(tmpdir(), 'callio-logthreads-')) },
    });
    let t = {};
    try { t = JSON.parse(run.stdout); } catch { /* reported below */ }
    check('worker threads follow level changes made in the main thread', t.before === 'info' && t.afterChange === 'trace', run.stdout || run.stderr);
    check('a worker thread started later gets the current levels', t.lateLevel === 'trace', run.stdout || run.stderr);
}

process.stdout.write(JSON.stringify(results));
process.exit(0);
