// Milestone A validation script — proves the SIP trunk can reach
// drachtio-server and complete a call, with rtpengine allocating a real
// media session. Standalone tool, not part of the Callio application:
// nothing under src/ imports this, and it has its own package.json.
//
// Deliberately does NOT promise an audible echo. Getting a true audio
// loopback out of rtpengine generally needs either a second call leg (a
// matching `answer` command) or a dedicated loopback feature this script
// doesn't use, and asserting one worked with real confidence isn't
// something to guess at. What this DOES prove, with full confidence:
//   1. The trunk's INVITE reaches drachtio-server (SIP signaling works)
//   2. drachtio-server can answer it (200 OK sent, ACK received)
//   3. rtpengine accepts the offer and allocates a real media session
//      (visible in its own logs / `rtpengine-ctl list numsessions`)
// That's Milestone A's actual goal: confirm the trunk+gateway path is real
// before any Node application code depends on it. Full audio-path
// verification is a RUNBOOK.md step using rtpengine's own diagnostics, not
// this script.
'use strict';

const Srf = require('drachtio-srf');
const { RtpEngineClient } = require('./rtpengine-ng-client');

const srf = new Srf();
const rtpengine = new RtpEngineClient({
    host: process.env.RTPENGINE_HOST || '127.0.0.1',
    port: Number(process.env.RTPENGINE_NG_PORT || 22222),
});

srf.connect({
    host: process.env.DRACHTIO_HOST || '127.0.0.1',
    port: Number(process.env.DRACHTIO_PORT || 9022),
    secret: process.env.DRACHTIO_SECRET || 'CHANGE_ME',
});

srf.on('connect', (err, hostport) => {
    if (err) {
        console.error('[call-test] failed to connect to drachtio-server:', err.message);
        return;
    }
    console.log(`[call-test] connected to drachtio-server at ${hostport}`);
    console.log('[call-test] waiting for a real inbound call from the trunk...');
});

srf.on('error', (err) => {
    console.error('[call-test] drachtio connection error:', err.message);
});

srf.invite(async (req, res) => {
    const callId = req.get('Call-ID');
    const fromTag = req.getParsedHeader('From').params.tag;
    console.log(`[call-test] INVITE received — Call-ID=${callId} From=${req.get('From')}`);

    try {
        const rtpAnswer = await rtpengine.offer({ callId, fromTag, sdp: req.body });
        if (rtpAnswer.result !== 'ok') {
            throw new Error(`rtpengine offer rejected: ${JSON.stringify(rtpAnswer)}`);
        }
        console.log(`[call-test] rtpengine accepted the offer, media session allocated for Call-ID=${callId}`);

        const dialog = await srf.createUAS(req, res, { localSdp: rtpAnswer.sdp });
        console.log(`[call-test] call answered (200 OK sent, ACK received) — Call-ID=${callId}`);
        console.log('[call-test] CHECKPOINT: if you got this far, SIP signaling + media negotiation both work.');
        console.log('[call-test] Verify RTP is actually arriving via: docker exec callio-rtpengine rtpengine-ctl list numsessions');

        dialog.on('destroy', async () => {
            console.log(`[call-test] call ended — Call-ID=${callId}`);
            try {
                await rtpengine.delete({ callId, fromTag });
            } catch (delErr) {
                console.error('[call-test] rtpengine delete failed (session may leak):', delErr.message);
            }
        });
    } catch (err) {
        console.error(`[call-test] failed to answer Call-ID=${callId}:`, err.message);
        res.send(500);
    }
});

process.on('SIGINT', () => {
    console.log('\n[call-test] shutting down...');
    rtpengine.close();
    process.exit(0);
});
