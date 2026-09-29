// Builds grafana/dashboards/callio-overview.json (the provisioned dashboard).
// Edit the panels here, then:  node deploy/observability/grafana/build-dashboard.mjs
import { writeFileSync } from 'fs';
const P = { type: 'prometheus', uid: 'prometheus' };
const L = { type: 'loki', uid: 'loki' };
let id = 0;
// refIds must be unique within a panel: A, B, C … assigned here.
const panel = (title, type, x, y, w, h, targets, extra = {}) => ({
    id: ++id, title, type, gridPos: { x, y, w, h }, datasource: targets[0].datasource,
    targets: targets.map((t, i) => ({ ...t, refId: String.fromCharCode(65 + i) })), ...extra,
});
const prom = (expr, legendFormat = '') => ({ datasource: P, expr, legendFormat });
const loki = (expr, legendFormat = '', queryType = 'range') => ({ datasource: L, expr, legendFormat, queryType });
const unit = (u) => ({ fieldConfig: { defaults: { unit: u }, overrides: [] } });
const sel = '{service="callio", env=~"$env"}';

const panels = [
    panel('Calls with media (now)', 'stat', 0, 0, 4, 4, [prom('sum(callio_media_calls_active{env=~"$env"})')]),
    panel('Agent sockets (now)', 'stat', 4, 0, 4, 4, [prom('sum(callio_agent_sockets{env=~"$env"})')]),
    panel('Calls ended (1h)', 'stat', 8, 0, 4, 4, [prom('sum(increase(callio_calls_ended_total{env=~"$env"}[1h]))')], unit('short')),
    panel('Errors logged (1h)', 'stat', 12, 0, 4, 4, [loki(`sum(count_over_time(${sel} | level="error" [1h]))`, '', 'instant')]),
    panel('Webhook failures (1h)', 'stat', 16, 0, 4, 4, [prom('sum(increase(callio_webhook_deliveries_total{env=~"$env",result="failed"}[1h]))')]),
    panel('Event-loop lag p99', 'stat', 20, 0, 4, 4, [prom('max(callio_nodejs_eventloop_lag_p99_seconds{env=~"$env"})')], unit('s')),

    panel('Calls ended by reason', 'timeseries', 0, 4, 12, 8, [prom('sum by (reason) (rate(callio_calls_ended_total{env=~"$env"}[5m])) * 60', '{{reason}}')], unit('cpm')),
    panel('Call duration p50 / p95', 'timeseries', 12, 4, 12, 8, [
        prom('histogram_quantile(0.5, sum by (le) (rate(callio_call_duration_seconds_bucket{env=~"$env"}[15m])))', 'p50'),
        prom('histogram_quantile(0.95, sum by (le) (rate(callio_call_duration_seconds_bucket{env=~"$env"}[15m])))', 'p95')], unit('s')),

    panel('HTTP requests by status', 'timeseries', 0, 12, 12, 8, [prom('sum by (status) (rate(callio_http_requests_total{env=~"$env"}[5m]))', '{{status}}')], unit('reqps')),
    panel('HTTP latency p95 by route', 'timeseries', 12, 12, 12, 8, [prom('histogram_quantile(0.95, sum by (le, route) (rate(callio_http_request_duration_seconds_bucket{env=~"$env"}[5m])))', '{{route}}')], unit('s')),

    panel('Log records by level', 'timeseries', 0, 20, 12, 8, [loki(`sum by (level) (count_over_time(${sel} [1m]))`, '{{level}}')]),
    panel('Warnings and errors by component', 'timeseries', 12, 20, 12, 8, [loki(`sum by (component) (count_over_time(${sel} | level=~"warn|error|fatal" [5m]))`, '{{component}}')]),

    panel('Memory (RSS) per worker', 'timeseries', 0, 28, 12, 7, [prom('callio_process_resident_memory_bytes{env=~"$env"}', 'worker {{worker}}')], unit('bytes')),
    panel('CPU per worker', 'timeseries', 12, 28, 12, 7, [prom('rate(callio_process_cpu_seconds_total{env=~"$env"}[1m])', 'worker {{worker}}')], unit('percentunit')),

    panel('Logs (filter: level, component, call)', 'logs', 0, 35, 24, 12, [loki(`${sel} | level=~"$level" | component=~"$component.*" | callId=~"$call.*"`)],
        { options: { showTime: true, wrapLogMessage: true, sortOrder: 'Descending', enableLogDetails: true } }),
];

const textbox = (name, label, value = '') => ({ type: 'textbox', name, label, query: value, current: { text: value, value } });
const dashboard = {
    uid: 'callio-overview', title: 'Callio — overview', tags: ['callio'], timezone: 'utc', schemaVersion: 39, version: 1,
    refresh: '30s', time: { from: 'now-6h', to: 'now' },
    templating: { list: [
        { type: 'query', name: 'env', label: 'env', datasource: P, query: { query: 'label_values(callio_process_start_time_seconds, env)', refId: 'env' },
            includeAll: true, multi: false, current: { text: 'All', value: '$__all' }, allValue: '.*', refresh: 2 },
        { type: 'custom', name: 'level', label: 'level', query: 'trace,debug,info,warn,error,fatal', multi: true, includeAll: true, allValue: '.*',
            current: { text: ['warn', 'error', 'fatal'], value: ['warn', 'error', 'fatal'] },
            options: [] },
        textbox('component', 'component (prefix)'),
        textbox('call', 'callId'),
    ] },
    panels,
};
writeFileSync(process.argv[2] ?? new URL('./dashboards/callio-overview.json', import.meta.url), JSON.stringify(dashboard, null, 2) + '\n');
