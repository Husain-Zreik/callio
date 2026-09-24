// Outbound SIP test call — dials a real number THROUGH the trunk, the
// opposite direction from call-test.js (which only answers inbound calls).
// Signaling-only by design: sends a syntactically valid but throwaway SDP
// offer, just to prove the trunk accepts and routes an outbound INVITE.
// Does NOT wire up rtpengine, so there is no real audio path — if the
// destination actually answers, this script ACKs and immediately hangs up
// rather than leaving a real human on a silent call.
//
// What this proves on success: the trunk accepts our outbound INVITE and
// actually rings the destination phone (180/183 provisional response) —
// confirming outbound routing works, independent of inbound (already
// verified separately via call-test.js).
//
// Must run from the server itself (same as options-ping.js) — connects to
// the local drachtio-server over its admin port, which then sends the real
// SIP traffic to the trunk.
'use strict';

const Srf = require('drachtio-srf');
const srf = new Srf();

const TRUNK_IP = process.env.TRUNK_IP || '185.231.78.58';
const DESTINATION_NUMBER = process.env.DESTINATION_NUMBER || '+96181030841';
const DESTINATION = `sip:${DESTINATION_NUMBER}@${TRUNK_IP}`;
const YOUR_DID = process.env.YOUR_DID || 'CHANGE_ME_TO_YOUR_ASSIGNED_DID';

const fakeSdp = [
    'v=0',
    'o=- 123456 123456 IN IP4 127.0.0.1',
    's=-',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    'm=audio 40000 RTP/AVP 0',
    'a=rtpmap:0 PCMU/8000',
    '',
].join('\r\n');

srf.connect({
    host: process.env.DRACHTIO_HOST || '127.0.0.1',
    port: Number(process.env.DRACHTIO_PORT || 9022),
    secret: process.env.DRACHTIO_SECRET || 'CHANGE_ME',
});

let rang = false;

srf.on('connect', async (err, hostport) => {
    if (err) {
        console.error('[outbound-test] failed to connect to drachtio-server:', err.message);
        process.exit(1);
    }
    console.log(`[outbound-test] connected to drachtio-server at ${hostport}`);
    console.log(`[outbound-test] dialing ${DESTINATION} as ${YOUR_DID} ...`);

    try {
        const { dialog } = await srf.createUAC(
            DESTINATION,
            {
                localSdp: fakeSdp,
                headers: {
                    'From': `<sip:${YOUR_DID}@${TRUNK_IP}>`,
                    'Contact': `<sip:${YOUR_DID}@92.204.169.121:5060>`,
                }
            },
            {
                cbRequest: (err, req) => {
                    if (err) return console.error('[outbound-test] failed to send INVITE:', err.message);
                    console.log(`[outbound-test] INVITE sent — Call-ID=${req.get('Call-ID')}`);
                },
                cbProvisional: (res) => {
                    console.log(`[outbound-test] provisional response: ${res.status} ${res.reason}`);
                    if (res.status === 180 || res.status === 183) {
                        rang = true;
                        console.log('[outbound-test] CHECKPOINT: destination phone is RINGING — outbound trunk routing confirmed.');
                    }
                },
            }
        );

        console.log('[outbound-test] call ANSWERED (200 OK + ACK completed).');
        console.log('[outbound-test] signaling-only test, no real audio configured — hanging up now.');
        setTimeout(() => {
            dialog.destroy();
            setTimeout(() => process.exit(0), 500);
        }, 1500);
    } catch (err) {
        if (rang) {
            console.log(`[outbound-test] call ended without being answered (${err.message || err}), but ringing WAS confirmed earlier — outbound trunk path works.`);
            process.exit(0);
        } else {
            console.error('[outbound-test] call failed before ringing:', err.message || err);
            process.exit(1);
        }
    }
});

srf.on('error', (err) => {
    console.error('[outbound-test] drachtio connection error:', err.message);
});

setTimeout(() => {
    console.error('[outbound-test] TIMEOUT — no response after 30s.');
    process.exit(1);
}, 30000);