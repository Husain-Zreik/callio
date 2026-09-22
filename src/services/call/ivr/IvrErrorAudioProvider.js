// services/call/ivr/IvrErrorAudioProvider.js
//
// Resolves the static IVR error audio file.
//
// Place your error audio file at:
//   node/storage/ivr/error/error_audio.<ext>
//
// Supported extensions (checked in order): mp3, wav, ogg, m4a, webm
// No uploads, no config — just drop the file in place and restart.

import { resolve as resolvePath, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname_esm = dirname(fileURLToPath(import.meta.url));

const STORAGE_DIR  = resolvePath(__dirname_esm, '../../../../storage/ivr/error');
const EXTENSIONS   = ['mp3', 'wav', 'ogg', 'm4a', 'webm'];
const BASE_NAME    = 'error_audio';

class IvrErrorAudioProvider {
    constructor() {
        this._path   = undefined; // undefined = not yet resolved; null = resolved but not found
    }

    /**
     * Return the absolute path to the error audio file, or null if none is present.
     * Result is cached after the first call.
     */
    getPath() {
        if (this._path !== undefined) return this._path;

        for (const ext of EXTENSIONS) {
            const candidate = resolvePath(STORAGE_DIR, `${BASE_NAME}.${ext}`);
            if (fs.existsSync(candidate)) {
                this._path = candidate;
                console.log(`[IvrErrorAudioProvider] Found static error audio: ${candidate}`);
                return this._path;
            }
        }

        console.warn(`[IvrErrorAudioProvider] No error audio file found in ${STORAGE_DIR} — callers will hear silence on error`);
        this._path = null;
        return null;
    }
}

export const ivrErrorAudioProvider = new IvrErrorAudioProvider();
