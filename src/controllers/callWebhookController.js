import { callWebhookProcessor } from '../services/call/webhook/CallWebhookProcessor.js';
import { isShuttingDown } from '../server/shutdown.js';

export async function handleCallWebhook(req, res) {
    try {
        const payload = req.body?.value;
        const phoneNumberId = payload?.metadata?.phone_number_id ?? 'UNKNOWN';
        const callsCount = Array.isArray(payload?.calls) ? payload.calls.length : 0;
        const statusesCount = Array.isArray(payload?.statuses) ? payload.statuses.length : 0;

        // A new inbound call created on this worker mid-shutdown never makes it into
        // shutdown.js's activeCalls/ivrCalls snapshot (taken once, early) and gets
        // abandoned when the process exits. A non-200 here tells Meta to retry the
        // delivery — it'll land on a worker that's actually able to see it through.
        if (isShuttingDown) {
            console.warn(`[Webhook] Rejecting during shutdown - phone=${phoneNumberId}, calls=${callsCount}, statuses=${statusesCount}`);
            res.sendStatus(503);
            return;
        }

        res.sendStatus(200);

        console.log(`[Webhook] Received - phone=${phoneNumberId}, calls=${callsCount}, statuses=${statusesCount}`);

        if (!payload) return;

        await callWebhookProcessor.process(payload);
    } catch (error) {
        console.error('[Webhook] Unhandled error:', error);
    }
}
