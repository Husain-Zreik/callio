// src/media/MediaRouter.js
// The media port's implementation (core/media/CallMedia.js): each call goes to
// the media its topology names (calls.media_topology) — a FreeSWITCH room
// (rooms/RoomMedia.js) or rtpengine alone (direct/DirectMedia.js). A call
// already held on this worker stays with whichever holds it; operations that
// only get a call id go there too, and to the rooms otherwise (they ignore a
// call they don't hold).
import { roomMedia } from './rooms/RoomMedia.js';
import { directMedia } from './direct/DirectMedia.js';
import { MediaTopology } from '../core/constants/CallConstants.js';

const BY_CALL = ['answerCustomer', 'offerCustomer', 'customerAnswered', 'offerAgent', 'agentAccepted', 'answerAgent', 'bridge',
    'addSupervisor', 'offerSupervisor', 'supervisorAnswered', 'adopt'];
const BY_ID = ['customerAudio', 'dropAgent', 'setSupervisorMode', 'setAgentPrivate', 'removeSupervisor', 'player', 'listenForDigits', 'startHold', 'stopHold'];

class MediaRouter {
    constructor() {
        for (const name of BY_CALL) this[name] = (call, ...args) => this._forCall(call)[name](call, ...args);
        for (const name of BY_ID) this[name] = (callId, ...args) => this._forId(callId)[name](callId, ...args);
    }

    _forId(callId) {
        return directMedia.owns(callId) ? directMedia : roomMedia;
    }

    _forCall(call) {
        if (directMedia.owns(call.id)) return directMedia;
        if (roomMedia.owns(call.id)) return roomMedia;
        return call.media_topology === MediaTopology.DIRECT ? directMedia : roomMedia;
    }

    hasAgentOffer(callId) { return directMedia.hasAgentOffer(callId) || roomMedia.hasAgentOffer(callId); }
    hasSupervisor(callId) { return directMedia.hasSupervisor(callId) || roomMedia.hasSupervisor(callId); }
    monitorState(callId) { return directMedia.monitorState(callId) ?? roomMedia.monitorState(callId); }
    owns(callId) { return directMedia.owns(callId) || roomMedia.owns(callId); }

    async close(callId) {
        await Promise.all([directMedia.close(callId), roomMedia.close(callId)]);
    }

    activeCallIds() { return [...roomMedia.activeCallIds(), ...directMedia.activeCallIds()]; }
    handOver() { return roomMedia.handOver() + directMedia.handOver(); }
    audioUrl(record) { return roomMedia.audioUrl(record); }
    errorAudio() { return roomMedia.errorAudio(); }
    stats() { return { ...roomMedia.stats(), ...directMedia.stats() }; }

    async start() {
        await roomMedia.start();
        await directMedia.start();
    }

    async stop() {
        await directMedia.stop();
        await roomMedia.stop();
    }
}

export const mediaRouter = new MediaRouter();
