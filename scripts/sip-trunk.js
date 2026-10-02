// Creates or updates a SIP trunk (operator-side, like consumer:create).
// Prints its id — SIP channels reference it as sip_trunk_id.
//
//   npm run sip:trunk -- --name digitalk --host 185.231.78.58 [--port 5060] [--transport UDP]
//                        [--cidr 185.231.78.58/32 --cidr …] [--username u --password p]
//                        [--consumer <slug>]      (omit = a platform trunk every consumer may use)
//                        [--country 961 [--strip 0]]   (the carrier sends national numbers: read them as +961…)
import SipTrunkRepository from '../src/persistence/SipTrunkRepository.js';
import ConsumerRepository from '../src/persistence/ConsumerRepository.js';
import connection from '../config/dbConnection.js';

const args = process.argv.slice(2);
const arg = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const all = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));

try {
    const name = arg('name');
    const host = arg('host');
    if (!name || !host) throw new Error('--name and --host are required');

    let consumerId = null;
    if (arg('consumer')) {
        const consumer = await ConsumerRepository.findBySlug(arg('consumer'));
        if (!consumer) throw new Error(`No consumer "${arg('consumer')}"`);
        consumerId = consumer.id;
    }
    const cidrs = all('cidr');
    const trunk = await SipTrunkRepository.upsert({
        consumerId,
        name,
        host,
        port: Number(arg('port', 5060)),
        transport: String(arg('transport', 'UDP')).toUpperCase(),
        credentials: arg('username') ? { username: arg('username'), password: arg('password') ?? '' } : undefined,
        inboundSourceCidrs: cidrs.length ? cidrs : null,
        numberRules: arg('country') ? { country_code: String(arg('country')), ...(arg('strip') != null ? { national_prefix: String(arg('strip')) } : {}) } : null,
    });
    if (!cidrs.length) console.warn('No --cidr given: INVITEs from any source are accepted for this trunk (development only).');
    console.log(JSON.stringify({ sip_trunk: trunk }, null, 2));
} catch (err) {
    console.error('sip:trunk failed:', err.message);
    process.exitCode = 1;
} finally {
    await connection.end();
}
