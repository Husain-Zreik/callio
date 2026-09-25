// Single source of truth for all environment variables.
// Rule: never read process.env directly anywhere else in the codebase — always
// import { config } from this file. The one explicit exception is ecosystem.config.cjs,
// which is CJS PM2 infrastructure that runs before the ESM app process exists.
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envPath = resolve(__dirname, "../.env");
dotenv.config({ path: envPath });

// Export all config in a structured way
export const config = {
    database: {
        host: process.env.DB_HOST || "127.0.0.1",
        port: parseInt(process.env.DB_PORT) || 3306,
        user: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
        poolLimit: parseInt(process.env.DB_POOL_LIMIT) || 10,
    },
    node: {
        host: process.env.NODE_HOST || "127.0.0.1",
        port: parseInt(process.env.PORT) || parseInt(process.env.NODE_PORT) || 3001,
        corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS
            ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(s => s.trim())
            : '*',
    },
    whatsapp: {
        apiUrl: process.env.WHATSAPP_API_URL,
        // Meta app secret used to verify X-Hub-Signature-256 on webhooks Meta
        // posts to Callio directly. Unset = direct Meta ingress disabled (the
        // API-key-authenticated forward endpoint still works).
        appSecret: process.env.WHATSAPP_APP_SECRET || null,
        // Token Meta echoes during webhook subscription verification (GET).
        verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || null,
    },
    security: {
        // 32-byte key (base64) that encrypts secrets at rest: channel
        // credentials, consumer signing keys, webhook secrets, push credentials.
        // Rotating it requires re-encrypting those columns.
        masterKey: process.env.CALLIO_MASTER_KEY || null,
    },
    paths: {
        root: resolve(__dirname, ".."),
    },
    redis: {
        host: process.env.REDIS_HOST || "127.0.0.1",
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || null,
        db: parseInt(process.env.REDIS_DB) || 0,
        connectTimeoutMs: parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS) || 5000,
    },
    runtime: {
        workerId: process.env.WORKER_ID || process.env.pm_id || process.pid,
        pmId: process.env.pm_id ?? null,
    },
    firebase: {
        // Own local copy, not shared with Laravel — see storage/firebase/.
        credentialsPath:
            process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
            resolve(__dirname, "../storage/firebase/google-services.json"),
    },
    apple: {
        // APNs Auth Key (token-based auth, .p8) — covers both regular push
        // and VoIP push with one key (unlike the legacy per-type
        // certificate approach, no yearly renewal). Used by ApnsVoipService
        // for incoming-call VoIP pushes (PushKit/CallKit).
        apnsKeyPath:
            process.env.APNS_AUTH_KEY_PATH ||
            resolve(__dirname, "../storage/apple/AuthKey.p8"),
        apnsKeyId: process.env.APNS_KEY_ID || null,
        apnsTeamId: process.env.APNS_TEAM_ID || null,
        // The iOS app's bundle id; VoIP pushes go to "<bundleId>.voip".
        bundleId: process.env.APNS_BUNDLE_ID || null,
        production: process.env.APNS_PRODUCTION === "true",
    },
    storage: {
        local: {
            // Root for audio assets stored on local disk (storage_provider 'local').
            root: process.env.STORAGE_LOCAL_ROOT
                ? resolve(process.env.STORAGE_LOCAL_ROOT)
                : resolve(__dirname, "../storage/app"),
        },
        s3: {
            region: process.env.AWS_DEFAULT_REGION || "eu-central-1",
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            bucket: process.env.AWS_BUCKET,
            prefix: process.env.S3_RECORDINGS_PREFIX || "recordings/",
            // Optional key prefix applied when reading objects (e.g. a shared
            // bucket partitioned per environment).
            bucketPrefix: process.env.AWS_BUCKET_PREFIX
                ? process.env.AWS_BUCKET_PREFIX.replace(/\/+$/, '') + '/'
                : '',
        },
        signedUrlExpiry: parseInt(process.env.S3_SIGNED_URL_EXPIRY) || 3600, // 1 hour default
        // Public base URL for objects, used when a signed URL can't be generated.
        publicUrl: process.env.AWS_URL || null,
    },
    logging: {
        enableNotificationLogs: process.env.ENABLE_NOTIFICATION_LOGS === "true",
    },
    notifications: {
        oneSignal: {
            appId: process.env.ONESIGNAL_APP_ID || null,
            restApiKey: process.env.ONESIGNAL_REST_API_KEY || null,
            timeoutMs: parseInt(process.env.ONESIGNAL_TIMEOUT || "10000", 10) || 10000,
        },
        // Per-preset overrides — every value is env-tunable so ops can swap
        // sounds/channels/ttls/icons without touching code or redeploying.
        presets: {
            call: {
                ttl: parseInt(process.env.NOTIF_CALL_TTL || "30", 10) || 30,
                iosSound: process.env.NOTIF_CALL_IOS_SOUND || "ringtone.wav",
                androidSound: process.env.NOTIF_CALL_ANDROID_SOUND || "ringtone",
                androidChannelId: process.env.NOTIF_CALL_ANDROID_CHANNEL_ID || null,
                androidAccentColor: process.env.NOTIF_CALL_ACCENT_COLOR || "FF00B87A",
                iosCategory: process.env.NOTIF_CALL_IOS_CATEGORY || "INCOMING_CALL",
                iosInterruptionLevel: process.env.NOTIF_CALL_IOS_INTERRUPTION || "time_sensitive",
                icon: process.env.NOTIF_CALL_ICON || "/images/call-icon.png",
                appUrl: process.env.APP_URL || null,
            },
        },
    },
    webrtc: {
        turn: {
            serverUrl: process.env.TURN_SERVER_URL || null,
            username: process.env.TURN_USERNAME || null,
            credential: process.env.TURN_CREDENTIAL || null,
        },
    },
    call: {
        recordingStorageLimitGb: parseInt(process.env.RECORDING_STORAGE_LIMIT_GB || "1", 10) || 1,
        workers: {
            encodingWorkerCount: parseInt(process.env.ENCODING_WORKER_COUNT) || 2,
            maxCallsPerWorker: parseInt(process.env.MAX_CALLS_PER_WORKER) || 10,
        },
    },
};
