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
check('context fields reach every record in the flow', r.every((x) => x.callId === 7));
check("one record's fields do not leak into the next", r[1] && r[1].first === undefined, JSON.stringify(r[1]));

r = took(() => runWithLogContext({ callId: 8 }, () => {}) ?? log.info('outside'));
check('context does not outlive its flow', r[0] && r[0].callId === undefined, JSON.stringify(r[0]));

r = took(() => log.info({ token: 'abc', nested: { secret: 's' }, apiKey: 'k' }, 'secrets'));
check('secrets are redacted', r[0].token === '[redacted]' && r[0].nested.secret === '[redacted]' && r[0].apiKey === '[redacted]', JSON.stringify(r[0]));

r = took(() => log.error({ err: new Error('boom') }, 'failed'));
check('errors keep type, message and stack', r[0].err?.message === 'boom' && /Error: boom/.test(r[0].err?.stack ?? ''));

r = took(() => { setLogLevels({ levels: { check: 'warn' } }); log.info('hidden'); log.warn('shown'); });
check('a prefix level applies to the components under it', r.length === 1 && r[0].msg === 'shown', JSON.stringify(r.map((x) => x.msg)));
r = took(() => { setLogLevels({ levels: { 'check.logging.Sample': 'debug' } }); log.debug('deeper'); });
check('the longest matching prefix wins', r.length === 1);

const seen = [throttle('k', 60_000), throttle('k', 60_000), throttle('k', 60_000)];
check('throttle lets the first through and counts the rest', seen[0] === 0 && seen[1] === null && seen[2] === null, JSON.stringify(seen));

process.stdout.write(JSON.stringify(results));
process.exit(0);
