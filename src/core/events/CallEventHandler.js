// src/core/events/CallEventHandler.js
import { EventTypes, isValidEventType } from './EventTypes.js';
import { CallErrorCodes } from './CallErrorCodes.js';
import { emitCallError } from './CallErrorEmitter.js';
import { AgentEventHandler } from './handlers/AgentEventHandler.js';
import { InitiationEventHandler } from './handlers/InitiationEventHandler.js';
import { ConnectionEventHandler } from './handlers/ConnectionEventHandler.js';
import { MonitorEventHandler } from './handlers/MonitorEventHandler.js';
import { CustomerEventHandler } from './handlers/CustomerEventHandler.js';
import { TerminationEventHandler } from './handlers/TerminationEventHandler.js';
import { RejectionEventHandler } from './handlers/RejectionEventHandler.js';
import { TransferEventHandler } from './handlers/TransferEventHandler.js';
import { agentAssignmentCoordinator } from '../routing/AgentAssignmentCoordinator.js';
import { logger } from '../../infra/logging/logger.js';
import { endedDuringWork } from '../calls/endedDuringWork.js';
import CallRepository from '../../persistence/CallRepository.js';
import { CallStatus } from '../constants/CallConstants.js';
import { callInbox } from '../../infra/cluster/CallInbox.js';
import { mediaLegs } from '../media/MediaLegs.js';

const log = logger('core.events.CallEventHandler');

export class CallEventHandler {
    constructor() {
        this.handleCallEvent = this.handleCallEvent.bind(this);

        this.agentHandler = new AgentEventHandler();
        this.connectionHandler = new ConnectionEventHandler();
        this.monitorHandler = new MonitorEventHandler();
        this.initiationHandler = new InitiationEventHandler();
        this.customerHandler = new CustomerEventHandler();
        this.terminationHandler = new TerminationEventHandler();
        this.rejectionHandler = new RejectionEventHandler();
        this.transferHandler = new TransferEventHandler();

        agentAssignmentCoordinator.setCallEventCallback(this.handleCallEvent);
    }

    // Outbound step 1 (Management API): the consumer asks for a call.
    async createOutboundIntent(data) {
        return this.initiationHandler.createOutboundIntent(data);
    }

    // Outbound step 2 (agent socket call:start): the agent connects its leg.
    async startCall(data) {
        return this.initiationHandler.handleCallStart(data, this.handleCallEvent);
    }

    // A CALL_TERMINATED can be a request to end the call or the notice that it
    // ended; the call's lease and inbox go only once the row says it's over.
    async #releaseIfEnded(callId) {
        const call = await CallRepository.findById(callId);
        if (!call || call.status === CallStatus.TERMINATED || call.status === CallStatus.FAILED) {
            await callInbox.release(callId, { purge: true });
        }
    }

    async handleCallEvent(eventType, data) {
        const { callId } = data;

        log.debug({ callId }, `Handling ${eventType}`);

        if (!isValidEventType(eventType)) {
            log.warn({ callId, eventType }, 'Unknown event type');
            return;
        }

        try {
            switch (eventType) {
                case EventTypes.OFFER_AGENT:
                    // Asked by another worker (AgentAssignmentCoordinator): the
                    // agent leg has to be made here, where the customer's leg is.
                    return await mediaLegs.offerAgent(await CallRepository.findById(callId));

                case EventTypes.CALL_INITIATE:
                    await this.initiationHandler.handleCallInitiated(data);
                    break;

                case EventTypes.AGENT_JOINED:
                    await this.agentHandler.handleAgentJoined(data);
                    break;

                case EventTypes.AGENT_RECONNECTED:
                    await this.connectionHandler.clearReconnectTimer(callId);
                    await this.agentHandler.handleAgentReconnected(data);
                    break;

                case EventTypes.AGENT_RECONNECT_ANSWERED:
                    await this.agentHandler.handleReconnectAnswered(data);
                    break;

                case EventTypes.RINGING_AGENT_RECONNECT:
                    await this.agentHandler.handleRingingAgentReconnect(data);
                    break;

                case EventTypes.AGENT_DISCONNECTED:
                    await this.connectionHandler.handleFrontendDisconnected(data);
                    break;

                case EventTypes.ICE_CANDIDATE:
                    await this.connectionHandler.handleICECandidate(data);
                    break;

                case EventTypes.MONITOR_STARTED:
                    await this.monitorHandler.handleMonitorStarted(data);
                    break;

                case EventTypes.MONITOR_ANSWERED:
                    await this.monitorHandler.handleMonitorAnswered(data);
                    break;

                case EventTypes.MONITOR_STOPPED:
                    await this.monitorHandler.handleMonitorStopped(data);
                    break;

                case EventTypes.MONITOR_MODE_CHANGED:
                    await this.monitorHandler.handleMonitorModeChanged(data);
                    break;

                case EventTypes.AGENT_PRIVATE_CHANGED:
                    await this.monitorHandler.handleAgentPrivateChanged(data);
                    break;

                case EventTypes.CUSTOMER_ANSWER_RECEIVED:
                    await this.customerHandler.handleCustomerAnswerReceived(data);
                    break;

                case EventTypes.CALL_TERMINATED:
                    await this.connectionHandler.clearReconnectTimer(callId);
                    await this.terminationHandler.handleCallTerminated(data);
                    await this.#releaseIfEnded(callId);
                    break;

                case EventTypes.CALL_REJECTED:
                    await this.rejectionHandler.handleCallRejected(data);
                    break;

                case EventTypes.CALL_TRANSFERRED:
                    await this.transferHandler.handleCallTransferred(data);
                    break;

                default:
                    log.warn({ callId, eventType }, 'Unhandled event type');
            }
        } catch (error) {
            log[endedDuringWork(error) ? 'warn' : 'error']({ callId, err: error }, `Error handling ${eventType}`);
            // Target the socket that triggered this event when we know it (data.socketId,
            // e.g. agent_joined/call_rejected) so a per-actor failure (like losing a
            // ring-group accept race) isn't broadcast to every socket in the call room —
            // that would show the *winning* agent a spurious error for a call they just
            // joined successfully. Falls back to the room broadcast when no socketId is
            // present (internal/system-originated events), same as before.
            emitCallError({ callId, code: CallErrorCodes.EVENT_HANDLER_FAILED, message: error.message, socketId: data.socketId });
        }
    }
}

export const callEventHandler = new CallEventHandler();
