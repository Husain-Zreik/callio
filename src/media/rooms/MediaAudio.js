// src/media/rooms/MediaAudio.js
// Audio the media server plays (IVR prompts, hold music, the IVR error
// prompt) is fetched from Callio over HTTP: GET /media/audio/<token>/<name>.
// The token signs which file it is, so the route needs no other auth and the
// URL is stable per file (FreeSWITCH caches what it fetches by URL). Callio
// streams the bytes from local storage or object storage; it never decodes
// them. The name's extension tells FreeSWITCH the format.
import { createHmac, timingSafeEqual } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { extname, basename, resolve as resolvePath } from 'path';
import { resolveStoragePath } from '../../infra/storage/StorageResolver.js';
import { storageClient } from '../../infra/storage/StorageClient.js';
import { config } from '../../../config/envConfig.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('media.rooms.MediaAudio');

const ERROR_AUDIO_DIR = resolvePath(config.paths.root, 'storage/ivr/error');
const ERROR_AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg'];
const TYPES = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg' };

const b64 = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

class MediaAudio {
    _sign(payload) {
        const key = config.security.masterKey ?? 'callio-media';
        return createHmac('sha256', key).update(`media-audio:${payload}`).digest('base64url').slice(0, 32);
    }

    // Audio is played by the worker that owns the call, so by default the
    // media server fetches it from that worker (where it already reaches it
    // for event-socket callbacks): no single worker serves every call's
    // prompts. MEDIA_CALLBACK_URL overrides it (a load balancer, say).
    _base() {
        if (config.media.callbackUrl) return config.media.callbackUrl;
        const host = config.media.freeswitch.advertisedAddress ?? '127.0.0.1';
        return `http://${host}:${config.node.port}`;
    }

    _url(source, name) {
        const base = this._base();
        const payload = b64(JSON.stringify(source));
        const safeName = basename(String(name)).replace(/[^\w.-]/g, '_') || 'audio.wav';
        return `${base}/media/audio/${payload}.${this._sign(payload)}/${safeName}`;
    }

    // An audio_assets record ({ storage_disk, storage_key }) → { url }.
    forRecord(record) {
        if (!record?.storage_key) return null;
        const provider = String(record.storage_disk ?? 'local').toLowerCase();
        return { url: this._url({ p: provider, k: record.storage_key }, record.storage_key) };
    }

    // The static IVR error prompt (storage/ivr/error/error_audio.<ext>), or null.
    errorAudio() {
        if (this._error !== undefined) return this._error;
        const ext = ERROR_AUDIO_EXTENSIONS.find((e) => existsSync(resolvePath(ERROR_AUDIO_DIR, `error_audio.${e}`)));
        this._error = ext ? { url: this._url({ p: 'error', k: `error_audio.${ext}` }, `error_audio.${ext}`) } : null;
        if (!ext) log.warn(`No error audio in ${ERROR_AUDIO_DIR} — callers hear silence on an IVR error`);
        return this._error;
    }

    // The token → { stream, type, length? } for the route, or null.
    async open(token) {
        const dot = String(token).lastIndexOf('.');
        if (dot < 1) return null;
        const payload = token.slice(0, dot);
        const given = Buffer.from(token.slice(dot + 1));
        const expected = Buffer.from(this._sign(payload));
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
        let source;
        try { source = JSON.parse(unb64(payload)); } catch { return null; }
        const type = TYPES[extname(String(source.k)).toLowerCase()] ?? 'application/octet-stream';

        if (source.p === 'error') {
            const path = resolvePath(ERROR_AUDIO_DIR, basename(source.k));
            return existsSync(path) ? { stream: createReadStream(path), type } : null;
        }
        if (source.p === 's3') {
            const buf = await storageClient.downloadBuffer(source.k);
            return { body: buf, type };
        }
        const path = await resolveStoragePath({ storage_disk: source.p, storage_key: source.k });
        return existsSync(path) ? { stream: createReadStream(path), type } : null;
    }
}

export const mediaAudio = new MediaAudio();
