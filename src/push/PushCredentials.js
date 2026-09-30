// src/push/PushCredentials.js
// Which credentials a push goes out with. Every consumer's app is its own
// Firebase project / Apple bundle / OneSignal app, so a push is sent with the
// credentials of the consumer the agent belongs to (consumers.push_credentials,
// set through the Management API). A provider the consumer hasn't set falls
// back to the platform's credentials from env.
//
// Stored shape (encrypted JSON), one optional section per provider:
//   fcm:       { service_account: { type, project_id, client_email, private_key, ... } }
//   apns:      { key_p8, key_id, team_id, bundle_id, production }
//   onesignal: { app_id, rest_api_key }
//
// Resolved sections carry a `key` — 'platform', or a fingerprint of the
// consumer's section — that the senders use to hold one client per credential
// set and to drop a client whose credentials were replaced.
import { createHash, createPrivateKey } from 'crypto';
import ConsumerRepository from '../persistence/ConsumerRepository.js';
import { config } from '../../config/envConfig.js';
import { logger } from '../infra/logging/logger.js';

const log = logger('push.PushCredentials');

// A change through the API clears this worker's cache at once; other workers
// see it within this long.
const CACHE_TTL_MS = 60_000;

export const PushProviders = Object.freeze(['fcm', 'apns', 'onesignal']);

const fingerprint = (section) => createHash('sha256').update(JSON.stringify(section)).digest('hex').slice(0, 16);

function platform() {
    const { apnsKeyPath, apnsKeyId, apnsTeamId, bundleId, production } = config.apple;
    const { appId, restApiKey } = config.notifications.oneSignal;
    return {
        fcm: { source: 'platform', key: 'platform', credentialsPath: config.firebase.credentialsPath },
        apns: apnsKeyId && apnsTeamId
            ? { source: 'platform', key: 'platform', keyPath: apnsKeyPath, keyId: apnsKeyId, teamId: apnsTeamId, bundleId, production }
            : null,
        onesignal: appId && restApiKey ? { source: 'platform', key: 'platform', appId, restApiKey } : null,
    };
}

function resolve(consumerId, stored) {
    const base = platform();
    const own = (provider) => stored?.[provider] ? { source: 'consumer', consumerId, key: `${consumerId}:${fingerprint(stored[provider])}` } : null;
    const fcm = own('fcm');
    const apns = own('apns');
    const onesignal = own('onesignal');
    return {
        fcm: fcm ? { ...fcm, serviceAccount: stored.fcm.service_account } : base.fcm,
        apns: apns ? {
            ...apns, keyPem: stored.apns.key_p8, keyId: stored.apns.key_id, teamId: stored.apns.team_id,
            bundleId: stored.apns.bundle_id, production: Boolean(stored.apns.production),
        } : base.apns,
        onesignal: onesignal ? { ...onesignal, appId: stored.onesignal.app_id, restApiKey: stored.onesignal.rest_api_key } : base.onesignal,
    };
}

class PushCredentials {
    constructor() {
        this._cache = new Map();   // consumerId → { at, value }
    }

    /** The credentials per provider for this consumer's agents ({ fcm, apns, onesignal }; a provider with none is null). */
    async forConsumer(consumerId) {
        if (consumerId == null) return platform();
        const hit = this._cache.get(String(consumerId));
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
        let stored = null;
        try {
            stored = await ConsumerRepository.getPushCredentials(consumerId);
        } catch (err) {
            // Unreadable (e.g. CALLIO_MASTER_KEY changed): don't push with another app's credentials.
            log.error({ consumerId, err }, 'Reading push credentials failed — pushing for this consumer is off');
            return { fcm: null, apns: null, onesignal: null };
        }
        const value = resolve(consumerId, stored);
        this._cache.set(String(consumerId), { at: Date.now(), value });
        return value;
    }

    platformFcm() { return platform().fcm; }
    platformApns() { return platform().apns; }
    platformOneSignal() { return platform().onesignal; }

    invalidate(consumerId) {
        this._cache.delete(String(consumerId));
    }

    /**
     * Check a section as the Management API receives it and return what is
     * stored. Throws an Error whose message names the problem.
     */
    validate(provider, body) {
        const str = (field, { max = 255 } = {}) => {
            const v = body?.[field];
            if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} is required`);
            if (v.length > max) throw new Error(`${field} must be at most ${max} characters`);
            return v.trim();
        };
        const parsesAsKey = (pem, field) => {
            try { createPrivateKey(pem); } catch { throw new Error(`${field} is not a valid private key`); }
        };
        switch (provider) {
            case 'fcm': {
                const sa = body?.service_account;
                if (!sa || typeof sa !== 'object' || Array.isArray(sa)) throw new Error('service_account is required: the Firebase service account JSON');
                if (sa.type !== 'service_account') throw new Error('service_account.type must be "service_account"');
                for (const f of ['project_id', 'client_email', 'private_key']) {
                    if (typeof sa[f] !== 'string' || !sa[f]) throw new Error(`service_account.${f} is required`);
                }
                parsesAsKey(sa.private_key, 'service_account.private_key');
                return { service_account: sa };
            }
            case 'apns': {
                const keyP8 = str('key_p8', { max: 4096 });
                parsesAsKey(keyP8, 'key_p8');
                const production = body.production ?? false;
                if (typeof production !== 'boolean') throw new Error('production must be true or false');
                return { key_p8: keyP8, key_id: str('key_id', { max: 32 }), team_id: str('team_id', { max: 32 }), bundle_id: str('bundle_id'), production };
            }
            case 'onesignal':
                return { app_id: str('app_id', { max: 64 }), rest_api_key: str('rest_api_key', { max: 512 }) };
            default:
                throw new Error(`provider must be one of ${PushProviders.join(', ')}`);
        }
    }

    /** What the API shows of a stored section — never a key. */
    describe(provider, section) {
        if (!section) return null;
        switch (provider) {
            case 'fcm': return { projectId: section.service_account?.project_id ?? null, clientEmail: section.service_account?.client_email ?? null };
            case 'apns': return { keyId: section.key_id, teamId: section.team_id, bundleId: section.bundle_id, production: Boolean(section.production) };
            case 'onesignal': return { appId: section.app_id };
            default: return null;
        }
    }
}

export const pushCredentials = new PushCredentials();
