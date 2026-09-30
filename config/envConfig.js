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
// Under PM2 the .env file wins: PM2 keeps the environment a process was
// first started with and re-injects it on every `pm2 restart`, so without
// override a changed .env (a new secret) would silently not apply. Outside
// PM2 (npm run dev, the e2e suites), variables already set take precedence.
dotenv.config({ path: envPath, override: process.env.pm_id !== undefined });

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
        // Default level, and per-component overrides by prefix:
        // LOG_LEVELS=media=warn,channels.sip=debug (longest prefix wins).
        // service / env on every record: tell services and servers apart in Loki.
        service: process.env.LOG_SERVICE || "callio",
        env: process.env.LOG_ENV || process.env.NODE_ENV || "development",
        level: (process.env.LOG_LEVEL || "info").toLowerCase(),
        levels: process.env.LOG_LEVELS || "",
        // stdout: on by default outside PM2 (PM2 sends worker output to /dev/null).
        stdout: process.env.LOG_STDOUT ? process.env.LOG_STDOUT === "true" : process.env.pm_id === undefined,
        // Lowest level shown on stdout (files keep everything the components log).
        stdoutLevel: (process.env.LOG_STDOUT_LEVEL || "trace").toLowerCase(),
        // stdout format: 'pretty' (readable lines) or 'json'. Files are always JSON.
        format: process.env.LOG_FORMAT || (process.env.NODE_ENV === "production" ? "json" : "pretty"),
        // Mask customer phone numbers / SIP users in records (off by default).
        maskPii: process.env.LOG_MASK_PII === "true",
        retentionDays: parseInt(process.env.LOG_RETENTION_DAYS || "14", 10) || 14,
        // Per worker per day; past it only warn and above are kept (0 = no cap).
        dailyCapMb: Math.max(0, parseInt(process.env.LOG_MAX_DAILY_MB || "1024", 10) || 0),
        dir: process.env.LOG_DIR ? resolve(process.env.LOG_DIR) : resolve(__dirname, "../storage/logs/app"),
    },
    metrics: {
        // Bearer token Prometheus sends to GET /metrics. Unset = endpoint off.
        token: process.env.METRICS_TOKEN || null,
    },
    notifications: {
        oneSignal: {
            appId: process.env.ONESIGNAL_APP_ID || null,
            restApiKey: process.env.ONESIGNAL_REST_API_KEY || null,
            apiUrl: process.env.ONESIGNAL_API_URL || "https://api.onesignal.com/notifications",
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
        stunUrls: (process.env.STUN_SERVER_URLS || "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302")
            .split(",").map((s) => s.trim()).filter(Boolean),
        turn: {
            serverUrl: process.env.TURN_SERVER_URL || null,
            username: process.env.TURN_USERNAME || null,
            credential: process.env.TURN_CREDENTIAL || null,
            // Set to issue short-lived credentials per agent (coturn use-auth-secret).
            secret: process.env.TURN_SECRET || null,
            ttlSeconds: parseInt(process.env.TURN_CREDENTIAL_TTL_SECONDS || "86400", 10) || 86400,
        },
    },
    // SIP channel: the drachtio-server + rtpengine gateway (deploy/sip-gateway).
    // Unset DRACHTIO_HOST = SIP disabled on this worker.
    sip: {
        drachtio: {
            host: process.env.DRACHTIO_HOST || null,
            port: parseInt(process.env.DRACHTIO_PORT || "9022", 10),
            secret: process.env.DRACHTIO_SECRET || null,
        },
        rtpengine: {
            host: process.env.RTPENGINE_HOST || "127.0.0.1",
            port: parseInt(process.env.RTPENGINE_NG_PORT || "22222", 10),
            // Named rtpengine interfaces for the carrier and WebRTC sides, when
            // rtpengine has more than one (rtpengine.conf interface = name/…).
            carrierInterface: process.env.RTPENGINE_CARRIER_INTERFACE || null,
            webrtcInterface: process.env.RTPENGINE_WEBRTC_INTERFACE || null,
        },
    },
    // URLs a consumer sets for itself (PUT /v1/webhook) must be https:// —
    // Callio POSTs to them. true only for local development and tests.
    webhooks: {
        allowHttp: process.env.WEBHOOK_ALLOW_HTTP === "true",
    },
    // How long call data is kept (core/calls/RetentionService). 0 days = keep.
    retention: {
        sweepSeconds: Math.max(10, Number(process.env.RETENTION_SWEEP_SECONDS ?? 3600) || 3600),
        callDetailDays: Math.max(0, Number(process.env.CALL_DETAIL_RETENTION_DAYS ?? 180) || 0),
        sdpHours: Math.max(0, Number(process.env.CALL_SDP_RETENTION_HOURS ?? 24) || 0),
        webhookDeliveryDays: Math.max(0, Number(process.env.WEBHOOK_DELIVERY_RETENTION_DAYS ?? 30) || 0),
        recordingDays: Math.max(0, Number(process.env.RECORDING_RETENTION_DAYS ?? 0) || 0),
    },
    call: {
        recordingStorageLimitGb: parseInt(process.env.RECORDING_STORAGE_LIMIT_GB || "1", 10) || 1,
        // A live call transferred to an agent who doesn't accept within this
        // goes back to its queue (inbound) or ends (outbound).
        transferTimeoutSeconds: parseInt(process.env.CALL_TRANSFER_TIMEOUT_SECONDS || "30", 10) || 30,
        workers: {
            encodingWorkerCount: parseInt(process.env.ENCODING_WORKER_COUNT) || 2,
            maxCallsPerWorker: parseInt(process.env.MAX_CALLS_PER_WORKER) || 10,
        },
    },
};
