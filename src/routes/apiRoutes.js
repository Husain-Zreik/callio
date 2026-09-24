// src/routes/apiRoutes.js
// callio only serves the calls domain — chat/orders/templates/activities
// webhook routes stayed behind in the monorepo.
import { handleCallWebhook } from "../controllers/callWebhookController.js";
import { handleCallCenterStatus } from "../controllers/callCenterController.js";
import { handleReleaseStaleCalls } from "../controllers/callCleanupController.js";
import { handleHealth } from "../controllers/healthController.js";
import { internalAuthMiddleware } from "./middleware/internalAuthMiddleware.js";

export default async function apiRoutes(fastify) {
    fastify.get("/health", handleHealth);

    // Everything below is a server-to-server call from Laravel — require the
    // shared internal API key (see middleware/internalAuthMiddleware.js).
    // Nested register() scopes the preHandler hook to just these routes
    // (Fastify's encapsulation model), the equivalent of Express's
    // router.use(internalAuthMiddleware) applying to everything registered
    // after it in the same router.
    fastify.register(async (protectedRoutes) => {
        protectedRoutes.addHook("preHandler", internalAuthMiddleware);

        protectedRoutes.post("/webhook", handleCallWebhook);
        // Business call-center enabled/disabled (account settings toggle, admin edit)
        protectedRoutes.post("/call-center/status", handleCallCenterStatus);
        // On-demand stale-call release, called from UserController::updateCallAvailability
        // instead of Laravel mutating the `calls` table itself — see TABLE_OWNERSHIP.md.
        protectedRoutes.post("/internal/calls/release-stale", handleReleaseStaleCalls);
    });
}
