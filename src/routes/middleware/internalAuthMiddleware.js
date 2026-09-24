// src/routes/middleware/internalAuthMiddleware.js
//
// Guards every server-to-server HTTP route Laravel calls into (webhook
// forwarding, call-center toggle, chat/order/template/activity push).
// Validates the X-Internal-Api-Key header against config.auth.internalApiKey.
//
// Degrades open (with a loud warning) when the key isn't configured yet, so
// this can ship before both .env files carry the same secret. Once set, it
// enforces unconditionally — there is no code path back to "open" after that
// other than unsetting the env var again.
import { timingSafeEqual } from "crypto";
import { config } from "../../../config/envConfig.js";

export async function internalAuthMiddleware(request, reply) {
    const expected = config.auth.internalApiKey;

    if (!expected) {
        console.warn("[InternalAuth] INTERNAL_API_KEY not set — internal routes are UNPROTECTED. Set it in every real environment.");
        return;
    }

    const provided = request.headers["x-internal-api-key"] || "";
    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(expected);

    const matches =
        providedBuf.length === expectedBuf.length &&
        timingSafeEqual(providedBuf, expectedBuf);

    if (!matches) {
        console.warn(`[InternalAuth] Rejected unauthenticated request to ${request.method} ${request.url}`);
        return reply.code(401).send({ error: "Unauthorized" });
    }
}
