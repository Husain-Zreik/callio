// src/core/media/CallMedia.js
// The media port: the core's only way to touch a call's audio. A call is a
// room (docs/media-architecture.md) — the customer, agents and supervisors
// are participants, and who hears whom is a rule on the room, not a wire.
// The implementation (src/media/rooms/) is registered at startup; the core
// sees SDP strings, participants and events, never a media server.
//
// `call` is a calls row ({ id, tenant_id, channel_id, … }). `profile` is the
// customer channel's sdpProfile (core/channels/CustomerChannels.js), which
// says how the customer leg is carried (`transport`: 'webrtc' | 'rtp') and
// holds the provider's SDP rewrites.
//
// Customer leg
//   answerCustomer(call, sdpOffer, profile) → sdpAnswer   inbound: answer the provider's offer
//   offerCustomer(call, profile) → sdpOffer               outbound: the offer to dial with
//   customerAnswered(call, sdpAnswer, profile)            outbound: the provider's answer
//   customerAudio(callId, timeoutMs) → bool               resolves once the customer's audio
//                                                         arrives (false on timeout)
// Agent legs
//   offerAgent(call) → sdpOffer          a leg for the agent being offered the call (ringing,
//                                        transfer); replaces a previous unanswered one
//   agentAccepted(call, agentId, sdpAnswer)
//                                        the agent's answer; resolves once their audio
//                                        arrives (rejects if it doesn't in time)
//   answerAgent(call, agentId, sdpOffer) → sdpAnswer
//                                        the agent offers (outbound call:start, reconnect);
//                                        replaces the agent's previous leg
//   dropAgent(callId, agentId)           the agent's leg is gone (transfer, reconnect,
//                                        disconnect); if no agent is left the customer
//                                        hears the reconnect tone
//   hasAgentOffer(callId)                this worker holds an unanswered agent leg
// The room
//   bridge(call)                         an agent and the customer are both up: put them
//                                        in the room (hold music stops; recording starts
//                                        when the line records)
// Supervisors
//   addSupervisor(call, supervisorId, sdpOffer) → sdpAnswer   joins listening (nobody hears them)
//   setSupervisorMode(callId, mode) → endedPrivate            'listen' | 'whisper' | 'barge'
//   setAgentPrivate(callId, active) → isPrivate               only while whispering
//   removeSupervisor(callId, supervisorId) → wasPrivate
//   hasSupervisor(callId)
//   monitorState(callId) → { mode, agentPrivate } | null   null with no supervisor
// Customer audio (IVR, queue)
//   player(callId) → { play(audio) → Promise, stop() }   a prompt to the customer alone;
//                                        `audio` is from audioUrl()
//   listenForDigits(callId, on)          DTMF from the customer → EventBus 'call:dtmf'
//   startHold(callId, audio|null) / stopHold(callId)
//                                        hold music on a loop (null: the built-in tone)
//   audioUrl(storageRecord) → audio      an audio asset as the media server fetches it
//   errorAudio() → audio|null            the IVR error prompt
// Lifecycle
//   close(callId)                        every leg; a recording finishes uploading
//   owns(callId)                         this worker holds legs of the call
//   activeCallIds() → [callId]           calls with legs on this worker
//   adopt(call) → bool                   take over a call whose worker died: rebuild its
//                                        room from the stored snapshot (false: nothing to take)
//   start() / stop() / stats()
// Events it emits on EventBus: 'call:dtmf' { callId, digit }, 'customer:media:state'
// { callId, state: 'drop'|'active' }, 'call:network:quality:customer' { callId, … },
// 'call:queue_audio_stop' { callId }.

const METHODS = [
    'answerCustomer', 'offerCustomer', 'customerAnswered', 'customerAudio',
    'offerAgent', 'agentAccepted', 'answerAgent', 'dropAgent', 'hasAgentOffer',
    'bridge',
    'addSupervisor', 'setSupervisorMode', 'setAgentPrivate', 'removeSupervisor', 'hasSupervisor', 'monitorState',
    'player', 'listenForDigits', 'startHold', 'stopHold', 'audioUrl', 'errorAudio',
    'close', 'owns', 'activeCallIds', 'adopt', 'start', 'stop', 'stats',
];

class CallMedia {
    constructor() {
        this._impl = null;
        for (const name of METHODS) {
            this[name] = (...args) => {
                if (!this._impl) throw new Error('No media implementation registered');
                return this._impl[name](...args);
            };
        }
    }

    register(impl) {
        const missing = METHODS.filter((m) => typeof impl?.[m] !== 'function');
        if (missing.length) throw new Error(`Media implementation lacks ${missing.join(', ')}`);
        this._impl = impl;
    }
}

export const callMedia = new CallMedia();
