// src/infra/monitoring/metrics.js
// Prometheus metrics, served per worker on GET /metrics (METRICS_TOKEN).
// Each worker is its own target (its own port); every series carries
// service / env / worker labels.
//
// Labels stay low-cardinality: channel, direction, status, route template —
// never call, tenant or agent ids (those belong in logs).
//
//   callio_calls_ended_total{channel,direction,reason,terminated_by}   reason: COMPLETED, NO_ANSWER, CANCELLED …
//   callio_call_duration_seconds{channel,direction}        answered calls
//   callio_call_ringing_seconds{channel,direction}         until answered or given up
//   callio_media_calls_active                               calls with media on this worker
//   callio_agent_sockets                                    agent sockets on this worker
//   callio_http_requests_total{method,route,status}
//   callio_http_request_duration_seconds{method,route}
//   callio_webhook_deliveries_total{result}                 delivered | retry | failed
//   callio_sip_invites_refused_total{status}                404 unknown number, 403 source
//   callio_log_records_dropped_total{reason}                buffer (stalled disk) | cap
//   Leak diagnostics (WorkerStatsService.diagnostics) — at idle these return to ~0 / a constant:
//   callio_retained_call_state{registry}   per-call state left behind; must be 0 with no calls
//   callio_native_audio_live{kind}         placeholder | source | sink (wrtc native objects)
//   callio_recordings_active, callio_active_timers, callio_active_handles,
//   callio_os_threads, callio_v8_detached_contexts, callio_eventbus_listeners
//   + Node process metrics: CPU, memory, event-loop lag, GC, handles (callio_ prefix)
import client from 'prom-client';
import { config } from '../../../config/envConfig.js';

export const registry = new client.Registry();
registry.setDefaultLabels({ service: config.logging.service, env: config.logging.env, worker: String(config.runtime.workerId) });
client.collectDefaultMetrics({ register: registry, prefix: 'callio_' });

const counter = (name, help, labelNames = []) => new client.Counter({ name, help, labelNames, registers: [registry] });
const histogram = (name, help, labelNames, buckets) => new client.Histogram({ name, help, labelNames, buckets, registers: [registry] });

export const metrics = Object.freeze({
    callsEnded: counter('callio_calls_ended_total', 'Calls that ended, by termination reason.', ['channel', 'direction', 'reason', 'terminated_by']),
    callDuration: histogram('callio_call_duration_seconds', 'Talk time of answered calls.', ['channel', 'direction'],
        [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600]),
    callRinging: histogram('callio_call_ringing_seconds', 'Ringing/waiting time until answered or given up.', ['channel', 'direction'],
        [1, 3, 5, 10, 20, 30, 60, 120, 300]),
    httpRequests: counter('callio_http_requests_total', 'HTTP requests, by route template and status.', ['method', 'route', 'status']),
    httpDuration: histogram('callio_http_request_duration_seconds', 'HTTP request handling time.', ['method', 'route'],
        [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]),
    webhookDeliveries: counter('callio_webhook_deliveries_total', 'Consumer webhook delivery attempts, by result.', ['result']),
    sipRefused: counter('callio_sip_invites_refused_total', 'Inbound SIP INVITEs refused, by response status.', ['status']),
    logDropped: counter('callio_log_records_dropped_total', 'Log records dropped to protect the service.', ['reason']),
});

/** Gauges read at scrape time from live state (called once by index.js). */
export function registerRuntimeGauges({ activeMediaCalls, agentSockets, diagnostics }) {
    const gauge = (name, help, labelNames = []) => new client.Gauge({ name, help, labelNames, registers: [registry] });
    // One diagnostics() read per scrape fills every leak gauge. The registry
    // collects in registration order, so this collector is registered first.
    let nativeAudio, plain;
    new client.Gauge({
        name: 'callio_retained_call_state', help: 'Per-call state held, by registry (must be 0 with no calls).',
        labelNames: ['registry'], registers: [registry],
        collect() {
            const d = diagnostics();
            this.reset();
            for (const [name, count] of Object.entries(d.retained?.breakdown ?? {})) this.set({ registry: name }, count);
            nativeAudio.set({ kind: 'placeholder' }, d.leaks.placeholderLive);
            nativeAudio.set({ kind: 'source' }, d.leaks.audioSourceLive);
            nativeAudio.set({ kind: 'sink' }, d.leaks.audioSinkLive);
            plain.recordings.set(d.activeRecordings);
            if (d.handles.timers != null) plain.timers.set(d.handles.timers);
            if (d.handles.total != null) plain.handles.set(d.handles.total);
            if (d.threads != null) plain.threads.set(d.threads);
            plain.detached.set(d.detachedContexts);
            if (d.eventBusListeners != null) plain.listeners.set(d.eventBusListeners);
        },
    });
    nativeAudio = gauge('callio_native_audio_live', 'Live wrtc native audio objects (should return to ~0 at idle).', ['kind']);
    plain = {
        recordings: gauge('callio_recordings_active', 'Recordings in progress on this worker.'),
        timers: gauge('callio_active_timers', 'Live timers (constant at idle; growth = a leaked interval).'),
        handles: gauge('callio_active_handles', 'Live libuv handles.'),
        threads: gauge('callio_os_threads', 'OS threads (Linux).'),
        detached: gauge('callio_v8_detached_contexts', 'Detached V8 contexts not yet collected (0 at idle).'),
        listeners: gauge('callio_eventbus_listeners', 'EventBus listeners (constant; growth = a handler never removed).'),
    };

    new client.Gauge({ name: 'callio_media_calls_active', help: 'Calls with media on this worker.', registers: [registry],
        collect() { this.set(activeMediaCalls()); } });
    new client.Gauge({ name: 'callio_agent_sockets', help: 'Agent sockets connected to this worker.', registers: [registry],
        collect() { this.set(agentSockets()); } });
}

const seconds = (from, to) => {
    const ms = new Date(to).getTime() - new Date(from).getTime();
    return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
};

/**
 * A call has ended (CallTerminator.settle — every end path goes through it).
 * `call` may be the row as it was before the final commit, so the outcome is
 * the termination reason and durations come from the row's timestamps.
 */
export function recordCallEnded(call, { reason, terminatedBy }, endedAt = new Date()) {
    const channel = call.channel ?? 'unknown';
    const direction = call.direction ?? 'unknown';
    metrics.callsEnded.inc({ channel, direction, reason: reason ?? 'unknown', terminated_by: terminatedBy ?? 'unknown' });
    const ringStart = call.ringing_at ?? call.created_at;
    const talk = call.answered_at ? seconds(call.answered_at, endedAt) : null;
    const ring = ringStart ? seconds(ringStart, call.answered_at ?? endedAt) : null;
    if (talk !== null) metrics.callDuration.observe({ channel, direction }, talk);
    if (ring !== null) metrics.callRinging.observe({ channel, direction }, ring);
}
