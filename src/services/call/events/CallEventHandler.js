// services/call/events/CallEventHandler.js
import { EventTypes, isValidEventType } from './EventTypes.js';
import { CallErrorCodes } from './CallErrorCodes.js';
import { emitCallError } from './CallErrorEmitter.js';
import { AgentEventHandler } from './handlers/AgentEventHandler.js';
import { InitiationEventHandler } from './handlers/InitiationEventHandler.js';
import { ConnectionEventHandler } from './handlers/ConnectionEventHandler.js';
import { MonitorEventHandler } from './handlers/MonitorEventHandler.js';
import { WhatsAppEventHandler } from './handlers/WhatsAppEventHandler.js';
import { TerminationEventHandler } from './handlers/TerminationEventHandler.js';
import { RejectionEventHandler } from './handlers/RejectionEventHandler.js';
import { TransferEventHandler } from './handlers/TransferEventHandler.js';
import { agentAssignmentCoordinator } from '../assignment/AgentAssignmentCoordinator.js';

export class CallEventHandler {
    constructor() {
        this.handleCallEvent = this.handleCallEvent.bind(this);

        this.agentHandler = new AgentEventHandler();
        this.connectionHandler = new ConnectionEventHandler();
        this.monitorHandler = new MonitorEventHandler();
        this.initiationHandler = new InitiationEventHandler();
        this.whatsappHandler = new WhatsAppEventHandler();
        this.terminationHandler = new TerminationEventHandler();
        this.rejectionHandler = new RejectionEventHandler();
        this.transferHandler = new TransferEventHandler();

        agentAssignmentCoordinator.setCallEventCallback(this.handleCallEvent);
    }

    async initiateCall(data) {
        return this.initiationHandler.handleCallInitiate(data, this.handleCallEvent);
    }

    async handleCallEvent(eventType, data) {
        const { callId } = data;

        console.log(`[CallEventHandler] 📨 Handling ${eventType} for call ${callId}`);

        if (!isValidEventType(eventType)) {
            console.warn(`[CallEventHandler] Unknown event type: ${eventType}`);
            return;
        }

        try {
            switch (eventType) {
                case EventTypes.CALL_INITIATE:
                    await this.initiationHandler.handleCallInitiated(data);
                    break;

                case EventTypes.AGENT_JOINED:
                    await this.agentHandler.handleAgentJoined(data);
                    break;

                case EventTypes.AGENT_RECONNECTED:
                    this.connectionHandler.clearReconnectTimer(callId);
                    await this.agentHandler.handleAgentReconnected(data);
                    break;

                case EventTypes.RINGING_AGENT_RECONNECT:
                    await this.agentHandler.handleRingingAgentReconnect(data);
                    break;

                case EventTypes.FRONTEND_DISCONNECTED:
                    await this.connectionHandler.handleFrontendDisconnected(data);
                    break;

                case EventTypes.ICE_CANDIDATE:
                    await this.connectionHandler.handleICECandidate(data);
                    break;

                case EventTypes.MONITOR_STARTED:
                    await this.monitorHandler.handleMonitorStarted(data);
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

                case EventTypes.WHATSAPP_ANSWER_RECEIVED:
                    await this.whatsappHandler.handleWhatsAppAnswerReceived(data);
                    break;

                case EventTypes.CALL_TERMINATED:
                    this.connectionHandler.clearReconnectTimer(callId);
                    await this.terminationHandler.handleCallTerminated(data);
                    break;

                case EventTypes.CALL_REJECTED:
                    await this.rejectionHandler.handleCallRejected(data);
                    break;

                case EventTypes.CALL_TRANSFERRED:
                    await this.transferHandler.handleCallTransferred(data);
                    break;

                default:
                    console.warn(`[CallEventHandler] Unhandled event type: ${eventType}`);
            }
        } catch (error) {
            const isKnownRace = error.message.includes('already terminated') || error.message.includes('already failed');
            console[isKnownRace ? 'warn' : 'error'](`[CallEventHandler] Error handling ${eventType} for call ${callId}:`, error.message);
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
