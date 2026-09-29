// scripts/log-level.js
// Change log levels on every running worker, live (src/infra/logging/LogLevelControl.js).
//
//   npm run log-level                                  show the current override
//   npm run log-level -- channels.sip=debug            debug for the SIP channel, for 1 hour
//   npm run log-level -- media=warn core.routing=trace --for 30m
//   npm run log-level -- --level debug --for 10m       change the default level
//   npm run log-level -- channels.sip=default          drop one override
//   npm run log-level -- --for 0 channels.sip=debug    no expiry (until --reset)
//   npm run log-level -- --reset                       back to .env (LOG_LEVEL / LOG_LEVELS)
//
// Overrides merge with the current one. Components are dotted and match by
// prefix: channels.sip covers channels.sip.SipIngress, channels.sip.SipDialogs …
// Levels: trace debug info warn error fatal silent.
import Redis from 'ioredis';
import { config } from '../config/envConfig.js';
import { LOG_LEVELS_CHANNEL, LOG_LEVELS_KEY } from '../src/infra/logging/logLevelKeys.js';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

function parseDuration(v) {
    if (v === '0') return 0;
    const m = /^(\d+)([smhd])$/.exec(String(v));
    if (!m) throw new Error(`--for takes e.g. 30m, 2h, 1d or 0 (got ${v})`);
    return Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2]];
}

const args = process.argv.slice(2);
const opts = { reset: false, level: null, forMs: 36e5, levels: {} };
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--reset') opts.reset = true;
    else if (a === '--level') opts.level = args[++i];
    else if (a.startsWith('--level=')) opts.level = a.slice(8);
    else if (a === '--for') opts.forMs = parseDuration(args[++i]);
    else if (a.startsWith('--for=')) opts.forMs = parseDuration(a.slice(6));
    else if (/^[\w.-]+=\w+$/.test(a)) {
        const [name, level] = a.split('=');
        if (!LEVELS.includes(level) && level !== 'default') throw new Error(`Unknown level "${level}" (${LEVELS.join(', ')}, default)`);
        opts.levels[name] = level;
    } else throw new Error(`Unknown argument: ${a}`);
}
if (opts.level && !LEVELS.includes(opts.level)) throw new Error(`Unknown level "${opts.level}"`);

const redis = new Redis({ host: config.redis.host, port: config.redis.port, password: config.redis.password, db: config.redis.db, maxRetriesPerRequest: 1 });
try {
    const raw = await redis.get(LOG_LEVELS_KEY);
    let current = raw ? JSON.parse(raw) : null;
    if (current?.expiresAt && Date.parse(current.expiresAt) <= Date.now()) current = null;

    const changing = opts.reset || opts.level || Object.keys(opts.levels).length;
    if (!changing) {
        console.log(`Configured (.env): LOG_LEVEL=${config.logging.level} LOG_LEVELS=${config.logging.levels || '(none)'}`);
        console.log(current ? `Override: ${JSON.stringify(current)}` : 'Override: none');
    } else if (opts.reset) {
        await redis.del(LOG_LEVELS_KEY);
        await redis.publish(LOG_LEVELS_CHANNEL, 'changed');
        console.log('Override removed — workers are back to the .env levels.');
    } else {
        const levels = { ...(current?.levels ?? {}) };
        for (const [name, level] of Object.entries(opts.levels)) {
            if (level === 'default') delete levels[name];
            else levels[name] = level;
        }
        const next = { levels, ...(opts.level ?? current?.level ? { level: opts.level ?? current.level } : {}) };
        if (opts.forMs) next.expiresAt = new Date(Date.now() + opts.forMs).toISOString();
        if (opts.forMs) await redis.set(LOG_LEVELS_KEY, JSON.stringify(next), 'PX', opts.forMs);
        else await redis.set(LOG_LEVELS_KEY, JSON.stringify(next));
        const workers = await redis.publish(LOG_LEVELS_CHANNEL, 'changed');
        console.log(`Override set: ${JSON.stringify(next)}`);
        console.log(`${workers} worker(s) notified${opts.forMs ? `; expires ${next.expiresAt}` : '; no expiry (npm run log-level -- --reset)'}`);
    }
} finally {
    redis.disconnect();
}
process.exit(0);
