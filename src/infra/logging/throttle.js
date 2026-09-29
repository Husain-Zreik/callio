// src/infra/logging/throttle.js
// For events that can repeat many times a second (scanner INVITEs, a failing
// retry loop): log the first, then one per window with the count in between.
//
//   const repeated = throttle(`sip-404:${ip}`);
//   if (repeated !== null) log.warn({ ip, ...(repeated && { repeated }) }, 'INVITE for an unknown number');
import { THROTTLE_WINDOW_MS } from './policy.js';

const MAX_KEYS = 5000;
const windows = new Map();   // key -> { until, suppressed }

/** null while inside the window after the last logged occurrence, else how many were suppressed since. */
export function throttle(key, windowMs = THROTTLE_WINDOW_MS) {
    const now = Date.now();
    const w = windows.get(key);
    if (w && now < w.until) { w.suppressed++; return null; }
    const suppressed = w?.suppressed ?? 0;
    windows.set(key, { until: now + windowMs, suppressed: 0 });
    if (windows.size > MAX_KEYS) for (const [k, v] of windows) if (v.until < now) windows.delete(k);
    return suppressed;
}
