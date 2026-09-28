// src/channels/sip/sipAddress.js
// Addresses on the SIP channel: DIDs and callers from SIP URIs, the user part
// to dial, and the trunk's inbound source check.
import Srf from 'drachtio-srf';
import { CustomerAddressType } from '../../core/constants/CallConstants.js';

const { parseUri } = Srf;
const PHONE = /^\+?\d{5,15}$/;

export function toE164(value) {
    if (!value) return null;
    const s = String(value).trim();
    return PHONE.test(s) ? `+${s.replace(/[^\d]/g, '')}` : null;
}

// The number a call was placed to: the Request-URI user, else the To user.
export function dialledNumber(req) {
    const fromUri = (uri) => { try { return parseUri(uri)?.user ?? null; } catch { return null; } };
    return toE164(fromUri(req.uri)) ?? toE164(fromUri(req.getParsedHeader('To')?.uri));
}

// The caller: a phone number when the From user is one, else the SIP URI.
export function callerOf(req) {
    const from = req.getParsedHeader('From') ?? {};
    let user = null;
    try { user = parseUri(from.uri)?.user ?? null; } catch { /* unparsable From */ }
    const e164 = toE164(user);
    const name = from.name ? String(from.name).replace(/^"|"$/g, '').trim() || null : null;
    return e164
        ? { address: e164, addressType: CustomerAddressType.E164, name }
        : { address: String(from.uri ?? 'sip:anonymous@anonymous.invalid'), addressType: CustomerAddressType.SIP_URI, name };
}

// The user part to put in an outbound Request-URI / From.
export function userPart(address) {
    const e164 = toE164(address);
    if (e164) return e164.slice(1);
    const m = /^sips?:([^@;>]+)@/i.exec(String(address));
    return m ? m[1] : String(address);
}

function ipv4ToInt(ip) {
    const parts = String(ip).split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

// Whether an INVITE's source address is one of the trunk's inbound CIDRs.
// No CIDRs configured = any source (development only).
export function sourceAllowed(trunk, sourceAddress) {
    const cidrs = trunk?.inbound_source_cidrs;
    if (!cidrs?.length) return true;
    const ip = String(sourceAddress ?? '').replace(/^::ffff:/, '');
    return cidrs.some((cidr) => {
        const [base, bitsRaw] = String(cidr).split('/');
        const ipInt = ipv4ToInt(ip);
        const baseInt = ipv4ToInt(base);
        if (ipInt == null || baseInt == null) return ip === base; // IPv6 / literal: exact match
        const bits = bitsRaw == null ? 32 : Number(bitsRaw);
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        return (ipInt & mask) === (baseInt & mask);
    });
}
