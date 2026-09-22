// src/services/storage/StreamUploader.js
import { Upload } from '@aws-sdk/lib-storage';
import { storageClient } from './StorageClient.js';
import { config } from '../../../config/envConfig.js';
import RecordingRepository from '../../repositories/RecordingRepository.js';
import { PassThrough } from 'stream';

class StreamUploader {
    constructor() {
        this.activeUploads = new Map(); // callId -> Upload
        this.trackMetadata = new Map(); // callId -> { bytesWritten }
        this.completionData = new Map(); // callId -> { recordingId, durationSeconds }
    }

    /**
     * Register the final duration for a call's recording so that upload.done()
     * can call markCompleted with the correct value once S3 confirms the upload.
     * Must be called before (or immediately after) uploadStream.end().
     */
    setCompletionData(callId, recordingId, durationSeconds) {
        this.completionData.set(callId, { recordingId, durationSeconds });
    }

    /**
     * Generate S3 key for stereo recording file.
     * Format: recordings/{businessId}/{callId}/{callId}_{timestamp}.ogg
     */
    generateKey(businessId, callId) {
        const timestamp = Date.now();
        const prefix = config.storage.s3.prefix;
        return `${prefix}${businessId}/${callId}/${callId}_${timestamp}.ogg`;
    }

    /**
     * Create a single streaming upload to S3 for the stereo recording.
     * @param {number} recordingId - Database recording ID
     * @param {number} businessId
     * @param {number} callId
     * @returns {Object} - { write, end, destroy }
     */
    async createUploadStream(recordingId, businessId, callId) {
        const key = this.generateKey(businessId, callId);
        const passThrough = new PassThrough();

        console.log(`[StreamUploader] Creating stereo upload stream: ${key}`);

        this.trackMetadata.set(callId, { bytesWritten: 0 });

        try {
            const upload = new Upload({
                client: storageClient.getClient(),
                params: {
                    Bucket: storageClient.getBucket(),
                    Key: key,
                    Body: passThrough,
                    ContentType: 'audio/ogg',
                    StorageClass: 'INTELLIGENT_TIERING',
                },
                queueSize: 4,
                partSize: 1024 * 1024 * 5, // 5 MB chunks
            });

            // Fire the upload and keep a reference so cleanup() can await the
            // same running promise — calling done() a second time throws.
            const uploadPromise = upload.done();
            uploadPromise
                .then(async () => {
                    const fileSize = this.trackMetadata.get(callId)?.bytesWritten ?? 0;
                    const completion = this.completionData.get(callId);

                    console.log(`[StreamUploader] ✅ Upload completed: ${key} (${fileSize} bytes)`);
                    await RecordingRepository.updateRecordingUrl(recordingId, key, fileSize);

                    // Transition to completed only after S3 confirms the upload and the
                    // URL is stored — prevents the "processing" stuck state on crashes.
                    if (completion) {
                        await RecordingRepository.markCompleted(completion.recordingId, completion.durationSeconds);
                        console.log(`[StreamUploader] ✅ Recording ${completion.recordingId} marked completed`);
                    }
                })
                .catch(async (error) => {
                    console.error(`[StreamUploader] ❌ Upload failed:`, error.message);
                    await RecordingRepository.markFailed(recordingId, `upload failed: ${error.message}`);
                })
                .finally(() => {
                    this.activeUploads.delete(callId);
                    this.trackMetadata.delete(callId);
                    this.completionData.delete(callId);
                });

            this.activeUploads.set(callId, { upload, uploadPromise });

            return {
                write: (chunk) => {
                    const meta = this.trackMetadata.get(callId);
                    if (meta) meta.bytesWritten += chunk.length;
                    return passThrough.write(chunk);
                },
                end: () => passThrough.end(),
                destroy: () => passThrough.destroy(),
            };

        } catch (error) {
            console.error(`[StreamUploader] ❌ Failed to create upload stream:`, error.message);
            throw error;
        }
    }

    /**
     * Abort active upload for a call
     */
    async abortUploads(callId) {
        const entry = this.activeUploads.get(callId);
        if (!entry) return;
        const { upload } = entry;

        console.log(`[StreamUploader] Aborting upload for call ${callId}`);
        try {
            await upload.abort();
            console.log(`[StreamUploader] Aborted upload for call ${callId}`);
        } catch (error) {
            console.error(`[StreamUploader] Failed to abort upload:`, error.message);
        } finally {
            // Always clean up Maps regardless of whether abort succeeded —
            // leaving entries causes the activeUploads Map to grow unboundedly.
            this.activeUploads.delete(callId);
            this.trackMetadata.delete(callId);
            this.completionData.delete(callId);
        }
    }

    /**
     * Get upload progress for a call
     */
    getUploadProgress(callId) {
        return this.activeUploads.has(callId) ? 'uploading' : null;
    }

    /**
     * Graceful shutdown: wait for all in-flight S3 uploads to complete.
     * Uploads are already streaming and their PassThrough ends have been signalled,
     * so they just need time to finish the multipart finalization with S3.
     *
     * @param {number} timeoutMs  Maximum wait time before giving up and aborting remainder.
     */
    async cleanup(timeoutMs = 45_000) {
        const count = this.activeUploads.size;
        if (count === 0) {
            console.log('[StreamUploader] No active uploads — cleanup complete');
            return;
        }

        console.log(`[StreamUploader] Waiting for ${count} in-flight upload(s) to complete (max ${timeoutMs / 1000}s)...`);

        const uploadPromises = [...this.activeUploads.entries()].map(([callId, { uploadPromise }]) =>
            uploadPromise
                .then(() => console.log(`[StreamUploader] ✅ Upload completed on shutdown for call ${callId}`))
                .catch((err) => console.warn(`[StreamUploader] ⚠️ Upload failed on shutdown for call ${callId}:`, err.message))
        );

        const timer = new Promise((resolve) => setTimeout(() => {
            console.warn(`[StreamUploader] ⏱️ Upload wait timed out — aborting ${this.activeUploads.size} remaining upload(s)`);
            resolve('timeout');
        }, timeoutMs));

        const result = await Promise.race([Promise.allSettled(uploadPromises), timer]);

        if (result === 'timeout') {
            for (const callId of [...this.activeUploads.keys()]) {
                await this.abortUploads(callId);
            }
        }

        console.log('[StreamUploader] ✅ Cleanup complete');
    }
}

export const streamUploader = new StreamUploader();
