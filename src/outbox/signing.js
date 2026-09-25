// src/outbox/signing.js
// Signature for requests Callio sends to consumers (event webhooks, lookup
// hook): X-Callio-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>.
// Consumers recompute it over the raw body and reject stale timestamps.
import { createHmac } from 'crypto';

export function signPayload(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
    const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return `t=${timestamp},v1=${mac}`;
}
