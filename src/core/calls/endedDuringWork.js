// src/core/calls/endedDuringWork.js
// The call (or one of its peers) ended while work on it was in progress: an
// accept racing a hang-up, an SDP answer for a leg already closed. Expected,
// handled — log it as warn, not error.
const MARKERS = ['already terminated', 'already failed', 'RTCPeerConnection is closed'];

export function endedDuringWork(err) {
    const message = String(err?.message ?? '');
    return MARKERS.some((m) => message.includes(m));
}
