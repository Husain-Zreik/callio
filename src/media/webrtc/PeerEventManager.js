// src/media/webrtc/PeerEventManager.js
import CallConnectionRepository from '../../persistence/CallConnectionRepository.js';
import { iceCoordinator } from './ice/ICECandidateCoordinator.js';
import { ConnectionType } from '../../core/constants/CallConstants.js';
import { EventEmitter } from './EventEmitter.js';
import EventBus from '../../core/EventBus.js';
import wrtc from '@roamhq/wrtc';
import { logger } from '../../infra/logging/logger.js';

const log = logger('media.webrtc.PeerEventManager');

export class PeerEventManager extends EventEmitter {
    constructor(iceCoordinator) {
        super();
        this.connectionStates = new Map();
        this.iceCoordinator = iceCoordinator;
    }

    setupPeerConnectionListeners(peerConnection, callId, connectionType, trackBuffer = []) {
        // Store named references so cleanup() can call removeEventListener.
        // Anonymous inline functions are unreachable after setup, so the 5 wrtc
        // native handlers would otherwise be retained until process exit.
        const handlers = {
            track: (event) => this.handleTrackEvent(peerConnection, event, callId, connectionType, trackBuffer),
            icegatheringstatechange: () => this.handleIceGatheringStateChange(peerConnection, callId, connectionType),
            icecandidate: (event) => this.handleIceCandidate(event, callId, connectionType),
            iceconnectionstatechange: () => this.handleIceConnectionStateChange(peerConnection, callId, connectionType),
            connectionstatechange: async () => { await this.handleConnectionStateChange(peerConnection, callId, connectionType); },
        };

        for (const [event, handler] of Object.entries(handlers)) {
            peerConnection.addEventListener(event, handler);
        }

        const key = `${callId}-${connectionType}`;
        this.connectionStates.set(key, {
            connectionState: peerConnection.connectionState,
            iceConnectionState: peerConnection.iceConnectionState,
            iceGatheringState: peerConnection.iceGatheringState,
            pc: peerConnection,
            handlers,
        });
    }

    handleTrackEvent(peerConnection, event, callId, connectionType, trackBuffer) {
        if (event.track.kind === 'audio') {
            if (trackBuffer) {
                trackBuffer.push({
                    track: event.track,
                    stream: event.streams[0] || new wrtc.MediaStream([event.track])
                });
            }

            this.emit('trackReceived', {
                callId,
                connectionType,
                track: event.track,
                stream: event.streams[0]
            });
        }
    }

    handleIceGatheringStateChange(peerConnection, callId, connectionType) {
        const state = peerConnection.iceGatheringState;
        const key = `${callId}-${connectionType}`;
        // Only update an entry that still exists. pc.close() fires state-change events
        // asynchronously AFTER cleanup() has removed the entry; recreating it here (via
        // `|| {}` + set) would leak one connectionStates entry per call.
        const storedState = this.connectionStates.get(key);
        if (storedState) storedState.iceGatheringState = state;

        CallConnectionRepository.updateICEGatheringState(callId, connectionType, state)
            .catch(err => log.error({ err }, 'Failed to update ICE gathering state'));
    }

    handleIceCandidate(event, callId, connectionType) {
        const candidate = event.candidate;
        if (!candidate) {
            return;
        }

        if (connectionType !== ConnectionType.CUSTOMER) {
            this.iceCoordinator.handleOutboundCandidate(callId, candidate, connectionType);
        }
    }

    handleIceConnectionStateChange(peerConnection, callId, connectionType) {
        const iceState = peerConnection.iceConnectionState;
        // Log every transition — the full timeline is essential for 138021 "no media"
        // analysis: we need to know exactly when (and whether) ICE reached 'connected'
        // for the CUSTOMER leg before the call was terminated.
        log.debug({ callId }, `ICE state: ${connectionType} → ${iceState}`);
        const key = `${callId}-${connectionType}`;
        // Only update an existing entry — never recreate after cleanup (see above).
        const storedState = this.connectionStates.get(key);
        if (storedState) storedState.iceConnectionState = iceState;

        CallConnectionRepository.updateICEState(callId, connectionType, iceState)
            .catch(err => log.error({ err }, 'Failed to update ICE state'));
    }

    async handleConnectionStateChange(peerConnection, callId, connectionType) {
        const connectionState = peerConnection.connectionState;
        const iceState = peerConnection.iceConnectionState;
        log.debug({ callId }, `Connection state: ${connectionType} → ${connectionState} (ice=${iceState})`);

        try {
            await CallConnectionRepository.updateConnectionState(callId, connectionType, connectionState, iceState);

            const key = `${callId}-${connectionType}`;
            // Ignore late events (e.g. the 'closed' fired by pc.close()) that arrive
            // after cleanup() removed the entry — recreating it would leak one entry/call.
            const storedState = this.connectionStates.get(key);
            if (!storedState) return;
            const oldConnectionState = storedState.connectionState;

            storedState.connectionState = connectionState;
            storedState.iceConnectionState = iceState;

            if (connectionState === 'connected' && oldConnectionState !== 'connected') {
                await CallConnectionRepository.markReady(callId, connectionType);
                this.emit('connectionReady', { callId, connectionType });

                if (connectionType === ConnectionType.CUSTOMER) {
                    this._setupDTMFReceiver(peerConnection, callId);
                }
            }

        } catch (error) {
            log.error({ err: error }, 'Failed to update connection state');
        }
    }

    getCurrentConnectionState(callId, connectionType) {
        const key = `${callId}-${connectionType}`;
        return this.connectionStates.get(key) || null;
    }

    isConnectionReady(callId, connectionType) {
        const state = this.getCurrentConnectionState(callId, connectionType);
        if (!state) return false;

        return state.connectionState === 'connected' ||
            state.iceConnectionState === 'connected' ||
            state.iceConnectionState === 'completed';
    }

    _setupDTMFReceiver(peerConnection, callId) {
        const receivers = peerConnection.getReceivers();
        log.debug({ callId }, `Inspecting ${receivers.length} receiver(s)`);

        receivers.forEach((receiver, i) => {
            const track = receiver.track;
            const hasDtmf = 'dtmf' in receiver;
            const dtmfValue = receiver.dtmf;
            const receiverKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(receiver))
                .filter(k => k !== 'constructor');

            log.debug(`Receiver[${i}]: kind=${track?.kind ?? 'null'}, readyState=${track?.readyState ?? 'null'}, 'dtmf' in receiver=${hasDtmf}, dtmf=${dtmfValue}, proto keys=[${receiverKeys.join(', ')}]`);

            // Also check transceiver if accessible
            try {
                const transceivers = peerConnection.getTransceivers?.();
                if (transceivers) {
                    log.debug(`getTransceivers returned ${transceivers.length} transceiver(s)`);
                    transceivers.forEach((t, ti) => {
                        log.debug(`Transceiver[${ti}]: direction=${t.direction}, currentDirection=${t.currentDirection}, mid=${t.mid}`);
                    });
                } else {
                    log.debug('getTransceivers not available on this peerConnection');
                }
            } catch (e) {
                log.debug({ err: e }, 'getTransceivers failed');
            }
        });

        for (const receiver of receivers) {
            if (receiver.track?.kind === 'audio' && receiver.dtmf) {
                receiver.dtmf.ontonechange = (event) => {
                    if (!event.tone) return; // empty string signals end of tone sequence
                    log.info({ callId }, `Digit '${event.tone}' detected`);
                    EventBus.emit('call:dtmf', { callId, digit: event.tone });
                };
                log.info({ callId }, 'RTCDtmfReceiver attached');
                return;
            }
        }
        // RTCDtmfReceiver not available in this wrtc build.
        // DTMF will be captured via RTCAudioSink-based DTMFCaptureService (Goertzel).
        // NOTE: If WhatsApp encodes keypresses as RFC 2833 RTP telephone-events (not
        // in-band PCM tones), Goertzel will also miss them. In that case DTMF detection
        // is entirely non-functional until RTCDtmfReceiver is supported by the wrtc build.
    }

    cleanup(callId, connectionType = null) {
        const keys = connectionType
            ? [`${callId}-${connectionType}`]
            : [...this.connectionStates.keys()].filter(k => k.startsWith(`${callId}-`));

        for (const key of keys) {
            const state = this.connectionStates.get(key);
            if (state?.pc && state?.handlers) {
                for (const [event, handler] of Object.entries(state.handlers)) {
                    try { state.pc.removeEventListener(event, handler); } catch { /* best effort */ }
                }
            }
            this.connectionStates.delete(key);
        }
    }
}

export const peerEventManager = new PeerEventManager(iceCoordinator);
