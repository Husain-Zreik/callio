// src/services/storage/StorageClient.js
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../../../config/envConfig.js';

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
            console.log('[StorageClient] Already initialized');
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
            credentials: {
                accessKeyId: s3.accessKeyId,
                secretAccessKey: s3.secretAccessKey,
            },
        });

        // Test connection
        await this.testConnection();

        this.isInitialized = true;
        console.log(`[StorageClient] ✅ Initialized - Bucket: ${this.bucket}, Region: ${this.region}`);
    }

    /**
     * Test S3 connection and bucket access
     */
    async testConnection() {
        try {
            const command = new HeadBucketCommand({ Bucket: this.bucket });
            await this.client.send(command);
            console.log(`[StorageClient] ✅ Bucket "${this.bucket}" is accessible`);
        } catch (error) {
            console.error(`[StorageClient] ❌ Bucket access failed:`, error.message);
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
            console.log(`[StorageClient] ✅ Uploaded: ${key}`);

            return fileUrl;
        } catch (error) {
            console.error(`[StorageClient] ❌ Upload failed for ${key}:`, error.message);
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
            console.log(`[StorageClient] ✅ Deleted: ${key}`);
            return true;
        } catch (error) {
            console.error(`[StorageClient] ❌ Delete failed for ${key}:`, error.message);
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
            console.log(`[StorageClient] Generated signed URL for: ${key}`);
            return signedUrl;
        } catch (error) {
            console.error(`[StorageClient] ❌ Signed URL generation failed for ${key}:`, error.message);
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
            console.log(`[StorageClient] ✅ Downloaded ${buf.length} bytes for: ${fullKey}`);
            return buf;
        } catch (error) {
            console.error(`[StorageClient] ❌ Download failed for ${key}:`, error.message);
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
            console.log('[StorageClient] ✅ Closed');
        }
    }
}

// Singleton instance
export const storageClient = new StorageClient();
