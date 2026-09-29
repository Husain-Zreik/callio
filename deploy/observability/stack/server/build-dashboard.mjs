// Builds server/dashboards/server-overview.json (Grafana folder "Server").
// Edit the panels here, then:  node deploy/observability/stack/server/build-dashboard.mjs
import { writeFileSync } from 'fs';

const P = { type: 'prometheus', uid: 'prometheus' };
let id = 0;
const panel = (title, type, x, y, w, h, targets, unit) => ({
    id: ++id, title, type, gridPos: { x, y, w, h }, datasource: P,
    targets: targets.map(([expr, legendFormat = ''], i) => ({ datasource: P, expr, legendFormat, refId: String.fromCharCode(65 + i) })),
    fieldConfig: { defaults: unit ? { unit } : {}, overrides: [] },
});
const fs = 'fstype!~"tmpfs|overlay|squashfs|ramfs|devtmpfs"';

const panels = [
    panel('CPU used', 'stat', 0, 0, 4, 4, [['1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))']], 'percentunit'),
    panel('Memory used', 'stat', 4, 0, 4, 4, [['1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes']], 'percentunit'),
    panel('Fullest disk', 'stat', 8, 0, 4, 4, [[`max(1 - node_filesystem_avail_bytes{${fs}} / node_filesystem_size_bytes{${fs}})`]], 'percentunit'),
    panel('Load (1 min)', 'stat', 12, 0, 4, 4, [['node_load1']]),
    panel('Uptime', 'stat', 16, 0, 4, 4, [['time() - node_boot_time_seconds']], 's'),
    panel('nginx active connections', 'stat', 20, 0, 4, 4, [['nginx_connections_active']]),

    panel('CPU by mode', 'timeseries', 0, 4, 12, 8, [['sum by (mode) (rate(node_cpu_seconds_total{mode!="idle"}[5m])) / scalar(count(count by (cpu) (node_cpu_seconds_total)))', '{{mode}}']], 'percentunit'),
    panel('Memory', 'timeseries', 12, 4, 12, 8, [
        ['node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes', 'used'],
        ['node_memory_MemAvailable_bytes', 'available']], 'bytes'),

    panel('Disk used by mount', 'timeseries', 0, 12, 12, 8, [[`1 - node_filesystem_avail_bytes{${fs}} / node_filesystem_size_bytes{${fs}}`, '{{mountpoint}}']], 'percentunit'),
    panel('Disk I/O', 'timeseries', 12, 12, 12, 8, [
        ['sum(rate(node_disk_read_bytes_total[5m]))', 'read'],
        ['sum(rate(node_disk_written_bytes_total[5m]))', 'written']], 'Bps'),

    panel('Network', 'timeseries', 0, 20, 12, 8, [
        ['sum(rate(node_network_receive_bytes_total{device!~"lo|docker.*|veth.*|br-.*"}[5m]))', 'in'],
        ['sum(rate(node_network_transmit_bytes_total{device!~"lo|docker.*|veth.*|br-.*"}[5m]))', 'out']], 'Bps'),
    panel('nginx requests', 'timeseries', 12, 20, 12, 8, [['rate(nginx_http_requests_total[5m])', 'requests/s']], 'reqps'),
];

const dashboard = {
    uid: 'server-overview', title: 'Server — overview', tags: ['server'], timezone: 'utc', schemaVersion: 39, version: 1,
    refresh: '30s', time: { from: 'now-6h', to: 'now' }, panels,
};
writeFileSync(process.argv[2] ?? new URL('./dashboards/server-overview.json', import.meta.url), JSON.stringify(dashboard, null, 2) + '\n');
