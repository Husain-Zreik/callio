// src/infra/monitoring/callStateCensus.js
//
// DIAGNOSTIC — counts every piece of per-call state held across the call stack.
// Each entry here is keyed by callId and MUST be emptied when the call ends.
// After a call finishes (and whenever the worker is idle with Calls(0)), EVERY
// count below — and therefore `total` — must be 0. A non-zero value at idle
// means that registry retained state for an ended call == a leak, and the
// breakdown pinpoints exactly which service failed to clean up.
//
// Pure read-only: only reads sizes of existing maps. Safe in production.
import { callMedia }            from '../../core/media/CallMedia.js';
import { ivrCoordinator }       from '../../core/ivr/IvrCoordinator.js';
import { redisPubSubService }   from '../redis/RedisPubSubService.js';

const sz = (m) => { try { return m?.size ?? 0; } catch { return 0; } };

/**
 * Snapshot of all per-call registries. `total` must be 0 when no calls are active.
 */
export function callStateCensus() {
    let media = { rooms: 0, legs: 0 };
    try { media = callMedia.stats(); } catch { /* no media registered */ }
    const breakdown = {
        mediaRooms:        media.rooms ?? 0,
        mediaLegs:         media.legs ?? 0,
        ivrSessions:       sz(ivrCoordinator._sessions),
        redisCallSubs:     sz(redisPubSubService.subscriptions),
    };

    let total = 0;
    for (const v of Object.values(breakdown)) total += v;

    return { total, breakdown };
}
