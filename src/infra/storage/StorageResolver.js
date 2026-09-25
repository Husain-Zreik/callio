// src/infra/storage/StorageResolver.js
//
// Centralised storage-path resolution for all audio/media files.
// Converts a { storage_disk, storage_key } record to an absolute local path
// or URL that can be passed directly to ffmpeg or an HTTP client.
//
// Supported providers (audio_assets.storage_provider):
//   's3'     → a presigned URL for the object key (a full URL is passed through)
//   'local'  → STORAGE_LOCAL_ROOT/{storage_key}
//   'public' → STORAGE_LOCAL_ROOT/public/{storage_key}
//
// The function is async so that S3 presigning can be added later without
// changing any caller.

import { resolve as resolvePath } from 'path';
import { storageClient } from './StorageClient.js';
import { config } from '../../../config/envConfig.js';

// Configurable via STORAGE_LOCAL_ROOT — see envConfig.js's storage.local.root.
const STORAGE_ROOT = config.storage.local.root;

function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || ''));
}

/**
 * Resolve a storage record to a local file path or URL.
 *
 * @param {{ storage_disk: string, storage_key: string }} record
 * @returns {Promise<string>} resolved absolute path or URL
 * @throws {Error} if storage_key is missing
 */
export async function resolveStoragePath({ storage_disk, storage_key }) {
    if (!storage_key) throw new Error('[StorageResolver] storage_key is required');

    switch (storage_disk) {
        case 's3': {
            // Accept pre-resolved URLs for backward compatibility.
            if (isHttpUrl(storage_key)) {
                return storage_key;
            }

            // Preferred path: convert S3 object key -> signed URL.
            try {
                return await storageClient.getSignedDownloadUrl(storage_key);
            } catch (err) {
                // Fallback for deployments exposing public/object URLs via AWS_URL.
                const base = String(config.storage.s3.publicUrl || '').replace(/\/+$/, '');
                const key = String(storage_key).replace(/^\/+/, '');
                if (base) {
                    return `${base}/${key}`;
                }
                throw new Error(`[StorageResolver] Could not resolve s3 key "${storage_key}": ${err.message}`);
            }
        }

        case 'public':
            return resolvePath(STORAGE_ROOT, 'public', storage_key);

        case 'local':
        default:
            return resolvePath(STORAGE_ROOT, storage_key);
    }
}
