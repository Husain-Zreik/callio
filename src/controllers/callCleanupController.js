// src/controllers/callCleanupController.js
// Internal endpoint (Laravel → node/) for on-demand stale-call release.
// See CallCleanupService.releaseStaleCallsForUser for why this exists —
// Node is the single owner of call-termination logic; Laravel calls in
// instead of mutating the `calls` table itself.
import { callCleanupService } from '../services/call/cleanup/CallCleanupService.js';

export async function handleReleaseStaleCalls(request, reply) {
    const userId = request.body?.user_id;

    if (!userId) {
        return reply.code(400).send({ error: 'user_id is required' });
    }

    try {
        const { releasedCount } = await callCleanupService.releaseStaleCallsForUser(userId);
        return reply.code(200).send({ success: true, released_count: releasedCount });
    } catch (err) {
        console.error(`[CallCleanup] release-stale failed for user ${userId}:`, err);
        return reply.code(500).send({ success: false, error: 'Internal error' });
    }
}
