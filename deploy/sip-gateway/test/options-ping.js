// SIP OPTIONS reachability probe — checks whether the SIP trunk is actually
// reachable and responding, without placing a real call. Run directly on the
// server (must originate from here, not from an arbitrary machine, since the
// trunk's firewall only expects/allows traffic to flow between it and this
// server's IP): node options-ping.js
//
// Any SIP response (200 OK, or even a 4xx) confirms the trunk is reachable
// and processing SIP traffic from this server. No response within the
// timeout means either a firewall/routing problem, or the trunk isn't
// listening the way expected — worth checking both directions (this
// server's outbound firewall rules, and the provider's own side) if it times
// out repeatedly.
'use strict';

const dgram = require('node:dgram');

const TRUNK_IP = process.env.TRUNK_IP || '185.231.78.58';
const TRUNK_PORT = Number(process.env.TRUNK_PORT || 5060);
const LOCAL_PORT = Number(process.env.LOCAL_PORT || 15070);
const TIMEOUT_MS = 5000;

const socket = dgram.createSocket('udp4');
const callId = `optionsping-${Date.now()}@callio`;
const fromTag = `tag-${Date.now()}`;

function buildOptions(localIp) {
    const branch = `z9hG4bK-${Date.now()}`;
    return [
        `OPTIONS sip:${TRUNK_IP} SIP/2.0`,
        `Via: SIP/2.0/UDP ${localIp}:${LOCAL_PORT};branch=${branch}`,
        `Max-Forwards: 70`,
        `From: <sip:callio@${localIp}>;tag=${fromTag}`,
        `To: <sip:${TRUNK_IP}>`,
        `Call-ID: ${callId}`,
        `CSeq: 1 OPTIONS`,
        `Contact: <sip:callio@${localIp}:${LOCAL_PORT}>`,
        `Content-Length: 0`,
        '',
        '',
    ].join('\r\n');
}

socket.on('message', (msg, rinfo) => {
    console.log(`\n<<< response from ${rinfo.address}:${rinfo.port} >>>`);
    console.log(msg.toString());
    console.log('\n[options-ping] SUCCESS — the trunk responded, SIP connectivity to it is confirmed.');
    socket.close();
    process.exit(0);
});

socket.on('error', (err) => {
    console.error('[options-ping] socket error:', err.message);
    process.exit(1);
});

socket.bind(LOCAL_PORT, () => {
    // Determine which local IP the OS will actually use to reach the trunk,
    // rather than guessing/hardcoding it.
    socket.connect(TRUNK_PORT, TRUNK_IP, () => {
        const localIp = socket.address().address;
        socket.disconnect();
        const packet = buildOptions(localIp);
        console.log(`[options-ping] sending OPTIONS to ${TRUNK_IP}:${TRUNK_PORT} from ${localIp}:${LOCAL_PORT}...`);
        socket.send(packet, TRUNK_PORT, TRUNK_IP);
    });
});

setTimeout(() => {
    console.error(`[options-ping] TIMEOUT — no response from ${TRUNK_IP}:${TRUNK_PORT} within ${TIMEOUT_MS}ms.`);
    console.error('[options-ping] Check: outbound firewall rules on this server, and confirm this is really the trunk\'s SIP signaling IP/port with the provider.');
    process.exit(1);
}, TIMEOUT_MS);
