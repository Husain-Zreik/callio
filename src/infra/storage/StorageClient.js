// src/infra/storage/StorageClient.js
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../../config/envConfig.js';
import { logger } from '../logging/logger.js';

const log = logger('infra.storage.StorageClient');

class StorageClient {
    constructor() {
        this.client = null;
        this.bucket = null;
        this.region = null;
        this.isInitialized = false;
    }

    /**
     * Initialize S3 client (call during app startup)
     */
    async init() {
        if (this.isInitialized) {
            log.debug('Already initialized');
            return;
        }

        const { s3 } = config.storage;

        if (!s3.accessKeyId || !s3.secretAccessKey || !s3.bucket) {
            throw new Error('[StorageClient] Missing S3 credentials in environment variables');
        }

        this.bucket = s3.bucket;
        this.region = s3.region;
        this.bucketPrefix = s3.bucketPrefix ?? '';

        this.client = new S3Client({
            region: s3.region,
            endpoint: s3.endpoint,
            forcePathStyle: s3.forcePathStyle,
            credentials: {
                accessKeyId: s3.accessKeyId,
                secretAccessKey: s3.secretAccessKey,
            },
        });

        // Test connection
        await this.testConnection();

        this.isInitialized = true;
        log.info(`Initialized - Bucket: ${this.bucket}, Region: ${this.region}`);
    }

    /**
     * Test S3 connection and bucket access
     */
    async testConnection() {
        try {
            const command = new HeadBucketCommand({ Bucket: this.bucket });
            await this.client.send(command);
            log.info(`Bucket "${this.bucket}" is accessible`);
        } catch (error) {
            log.error({ err: error }, 'Bucket access failed');
            throw new Error(`S3 bucket "${this.bucket}" is not accessible. Check credentials and bucket name.`);
        }
    }

    /**
     * Upload file to S3
     * @param {string} key - S3 object key (file path)
     * @param {Buffer|Stream} body - File content
     * @param {string} contentType - MIME type
     */
    async uploadFile(key, body, contentType = 'audio/webm') {
        this.ensureInitialized();

        try {
            const command = new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: body,
                ContentType: contentType,
            });

            await this.client.send(command);

            const fileUrl = `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
            log.info(`Uploaded: ${key}`);

            return fileUrl;
        } catch (error) {
            log.error({ err: error }, `Upload failed for ${key}`);
            throw error;
        }
    }

    /**
     * Delete file from S3
     * @param {string} key - S3 object key
     */
    async deleteFile(key) {
        this.ensureInitialized();

        try {
            const command = new DeleteObjectCommand({
                Bucket: this.bucket,
                Key: key,
            });

            await this.client.send(command);
            log.info(`Deleted: ${key}`);
            return true;
        } catch (error) {
            log.error({ err: error }, `Delete failed for ${key}`);
            return false;
        }
    }

    /**
     * Generate signed URL for downloading file (private access)
     * @param {string} key - S3 object key (without bucket prefix)
     * @param {number} expiresIn - URL expiry in seconds (default: 1 hour)
     */
    async getSignedDownloadUrl(key, expiresIn = config.storage.signedUrlExpiry) {
        this.ensureInitialized();

        try {
            const command = new GetObjectCommand({
                Bucket: this.bucket,
                Key: this.bucketPrefix + key,
            });

            const signedUrl = await getSignedUrl(this.client, command, { expiresIn });
            log.debug(`Generated signed URL for: ${key}`);
            return signedUrl;
        } catch (error) {
            log.error({ err: error }, `Signed URL generation failed for ${key}`);
            throw error;
        }
    }

    /**
     * A presigned PUT for `key`: the media server uploads a recording with it
     * (it holds no storage credentials).
     */
    async getSignedUploadUrl(key, contentType, expiresIn = config.storage.signedUrlExpiry) {
        this.ensureInitialized();
        const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType });
        return getSignedUrl(this.client, command, { expiresIn, signableHeaders: new Set(['content-type']) });
    }

    /**
     * { size } of an object, or null if it isn't there.
     */
    async head(key) {
        this.ensureInitialized();
        try {
            const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
            return { size: Number(r.ContentLength ?? 0) };
        } catch (error) {
            if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') return null;
            throw error;
        }
    }

    /**
     * Download an S3 object directly into a Buffer using IAM credentials.
     * Preferred over presigned URLs for server-side access — avoids HTTPS
     * signature validation issues that occur when fetching presigned URLs
     * from within the Node.js process.
     *
     * @param {string} key - S3 object key
     * @returns {Promise<Buffer>}
     */
    async downloadBuffer(key) {
        this.ensureInitialized();
        try {
            const fullKey = this.bucketPrefix + key;
            const command = new GetObjectCommand({ Bucket: this.bucket, Key: fullKey });
            const response = await this.client.send(command);
            const chunks = [];
            for await (const chunk of response.Body) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const buf = Buffer.concat(chunks);
            log.debug(`Downloaded ${buf.length} bytes for: ${fullKey}`);
            return buf;
        } catch (error) {
            log.error({ err: error }, `Download failed for ${key}`);
            throw error;
        }
    }

    /**
     * Extract S3 key from full URL
     * @param {string} url - Full S3 URL
     */
    extractKeyFromUrl(url) {
        if (!url) return null;

        // Extract key from URL: https://bucket.s3.region.amazonaws.com/recordings/1/123/agent.webm
        const urlParts = url.split('.amazonaws.com/');
        return urlParts.length > 1 ? urlParts[1] : null;
    }

    /**
     * Get S3 client for advanced operations
     */
    getClient() {
        this.ensureInitialized();
        return this.client;
    }

    /**
     * Get bucket name
     */
    getBucket() {
        this.ensureInitialized();
        return this.bucket;
    }

    /**
     * Ensure client is initialized before operations
     */
    ensureInitialized() {
        if (!this.isInitialized || !this.client) {
            throw new Error('[StorageClient] Not initialized. Call init() first.');
        }
    }

    /**
     * Cleanup resources (call during graceful shutdown)
     */
    async close() {
        if (this.client) {
            this.client.destroy();
            this.client = null;
            this.isInitialized = false;
            log.info('Closed');
        }
    }
}

// Singleton instance
export const storageClient = new StorageClient();
