// src/routes/apiRoutes.js
// callio only serves the calls domain — chat/orders/templates/activities
// webhook routes stayed behind in the monorepo.
import { Router } from "express";
import { handleCallWebhook } from "../controllers/callWebhookController.js";
import { handleCallCenterStatus } from "../controllers/callCenterController.js";
import { handleReleaseStaleCalls } from "../controllers/callCleanupController.js";
import { handleHealth } from "../controllers/healthController.js";
import { internalAuthMiddleware } from "./middleware/internalAuthMiddleware.js";
const router = Router();

router.get("/health", handleHealth);

// Everything below is a server-to-server call from Laravel — require the
// shared internal API key (see middleware/internalAuthMiddleware.js).
router.use(internalAuthMiddleware);

router.post("/webhook", handleCallWebhook);
// Business call-center enabled/disabled (account settings toggle, admin edit)
router.post("/call-center/status", handleCallCenterStatus);
// On-demand stale-call release, called from UserController::updateCallAvailability
// instead of Laravel mutating the `calls` table itself — see TABLE_OWNERSHIP.md.
router.post("/internal/calls/release-stale", handleReleaseStaleCalls);

export default router;
