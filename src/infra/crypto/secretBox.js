// Encrypts secrets stored in the database (channel credentials, consumer
// signing keys, webhook secrets, push credentials) with AES-256-GCM under
// CALLIO_MASTER_KEY. Ciphertext format: "v1:<iv b64>:<tag b64>:<data b64>".
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { config } from "../../../config/envConfig.js";

const VERSION = "v1";

function key() {
    const raw = config.security.masterKey;
    if (!raw) throw new Error("CALLIO_MASTER_KEY is not set — cannot encrypt or decrypt secrets");
    const buf = Buffer.from(raw, "base64");
    if (buf.length !== 32) throw new Error("CALLIO_MASTER_KEY must be 32 bytes, base64-encoded");
    return buf;
}

export function encryptSecret(plaintext) {
    if (plaintext == null) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key(), iv);
    const data = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
    return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decryptSecret(ciphertext) {
    if (ciphertext == null) return null;
    const [version, ivB64, tagB64, dataB64] = String(ciphertext).split(":");
    if (version !== VERSION || !ivB64 || !tagB64 || dataB64 == null) {
        throw new Error("Unrecognized secret format");
    }
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

export function encryptJson(value) {
    return value == null ? null : encryptSecret(JSON.stringify(value));
}

export function decryptJson(ciphertext) {
    const text = decryptSecret(ciphertext);
    return text == null ? null : JSON.parse(text);
}
