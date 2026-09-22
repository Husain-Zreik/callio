// src/controllers/callCleanupController.js
// Internal endpoint (Laravel → node/) for on-demand stale-call release.
// See CallCleanupService.releaseStaleCallsForUser for why this exists —
// Node is the single owner of call-termination logic; Laravel calls in
// instead of mutating the `calls` table itself.
import { callCleanupService } from '../services/call/cleanup/CallCleanupService.js';

export async function handleReleaseStaleCalls(req, res) {
    const userId = req.body?.user_id;

    if (!userId) {
        return res.status(400).json({ error: 'user_id is required' });
    }

    try {
        const { releasedCount } = await callCleanupService.releaseStaleCallsForUser(userId);
        return res.status(200).json({ success: true, released_count: releasedCount });
    } catch (err) {
        console.error(`[CallCleanup] release-stale failed for user ${userId}:`, err);
        return res.status(500).json({ success: false, error: 'Internal error' });
    }
}
