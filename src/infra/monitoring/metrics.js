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
export function registerRuntimeGauges({ activeMediaCalls, agentSockets }) {
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
