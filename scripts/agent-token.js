// Operator/dev CLI: signs an agent token the way a consumer's backend does
// (docs/agent-protocol.md, "The agent token"), with the consumer's signing
// key read from Callio's own database — for testing agent clients without a
// consumer backend. Prints only the token.
//
//   npm run agent:token -- --consumer <slug> --tenant <tenant_ref> --agent <agent_ref>
//                          [--name "Agent One"] [--role AGENT|SUPERVISOR] [--kid k1] [--minutes 60]
import jwt from 'jsonwebtoken';
import ConsumerRepository from '../src/persistence/ConsumerRepository.js';
import connection from '../config/dbConnection.js';

const args = process.argv.slice(2);
const arg = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };

try {
    const slug = arg('consumer');
    const tenant = arg('tenant');
    const agent = arg('agent');
    if (!slug || !tenant || !agent) throw new Error('--consumer, --tenant and --agent are required');

    const consumer = await ConsumerRepository.findBySlug(slug);
    if (!consumer) throw new Error(`No consumer "${slug}"`);
    const kid = arg('kid', 'k1');
    const secret = await ConsumerRepository.getSigningSecret(consumer.id, kid);
    if (!secret) throw new Error(`Consumer "${slug}" has no active signing key "${kid}"`);

    const role = arg('role');
    const token = jwt.sign(
        { iss: slug, tnt: String(tenant), sub: String(agent), ...(arg('name') ? { name: arg('name') } : {}), ...(role ? { role } : {}) },
        secret,
        { algorithm: 'HS256', keyid: kid, expiresIn: `${Number(arg('minutes', 60))}m` },
    );
    console.log(token);
} catch (err) {
    console.error('agent:token failed:', err.message);
    process.exitCode = 1;
} finally {
    await connection.end();
}
