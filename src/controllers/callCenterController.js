// src/controllers/callCenterController.js
import { callCenterToggleService } from '../services/call/cleanup/CallCenterToggleService.js';

/**
 * Laravel pushes this after has_call_center changes on a business (account
 * settings self-service toggle, or an admin editing the business directly).
 * Body: { business_id, enabled }. Only the disable direction needs action
 * here — enabling doesn't require forcing anyone into any particular state.
 */
export async function handleCallCenterStatus(req, res) {
    try {
        const { business_id: businessId, enabled } = req.body || {};

        if (!businessId || typeof enabled !== 'boolean') {
            return res.status(400).json({
                error: 'business_id and enabled (boolean) are required',
            });
        }

        if (!enabled) {
            await callCenterToggleService.disableForBusiness(businessId);
        }

        return res.json({ success: true });
    } catch (error) {
        console.error('[CallCenterWebhook] Error handling call center status change', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
