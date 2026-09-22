// src/websocket/namespaces/call/handlers/network.js
import EventBus from '../../../../services/core/EventBus.js';
import { roomManager } from '../../../managers/RoomManager.js';
import CallRepository from '../../../../repositories/CallRepository.js';
import { callLifecycleLogger } from '../../../../services/call/lifecycle/CallLifecycleLogger.js';
import { redisPubSubService } from '../../../../services/redis/RedisPubSubService.js';
import { EventTypes } from '../../../../services/call/events/EventTypes.js';

export function registerCallNetworkListeners(networkLossTimers) {
    EventBus.on('customer:media:state', async ({ callId, state }) => {
        const key = String(callId);

        // Real-time broadcast: agent and monitor UIs update immediately.
        roomManager.broadcastToCall(callId, 'call:customer:media:state', { callId, state });

        // Persist to the call lifecycle log so the timeline reflects customer-side
        // network events alongside agent disconnect/reconnect entries.
        // CustomerSilenceWatchdog only fires on genuine state transitions (never on
        // every frame), so each event here represents a real drop or recovery.
        try {
            const call = await CallRepository.findById(callId);
            if (!call?.business_id) return; // call already cleaned up — skip silently

            const businessId = call.business_id;
            const agentId = call.user_id ?? null;

            if (state === 'drop') {
                await callLifecycleLogger.logCustomerNetworkDrop(callId, businessId, agentId, {
                    detection_method: 'silence_watchdog',
                });

                // Cancel any existing timers (e.g. a previous drop cycle that didn't recover).
                const existing = networkLossTimers.get(key);
                if (existing) {
                    clearTimeout(existing.warnTimer);
                    clearTimeout(existing.terminateTimer);
                }

                // T+15 s: warn the agent that auto-termination is imminent.
                // Matches the UI's weak→lost transition (15 s), so the countdown
                // appears exactly when the "Customer connection lost" banner is shown.
                const warnTimer = setTimeout(() => {
                    roomManager.broadcastToCall(callId, 'call:network:terminating', { callId });
                }, 15_000);

                // T+20 s: terminate the call as CUSTOMER_NETWORK_LOSS.
                // Published via pubsub so CallEventHandler → TerminationEventHandler on
                // the owning worker handles it with idempotent markCallFailedIfNotFinal.
                const terminateTimer = setTimeout(async () => {
                    networkLossTimers.delete(key);
                    try {
                        await redisPubSubService.publishCallEvent(callId, EventTypes.CALL_TERMINATED, {
                            callId,
                            reason: 'customer_network_loss',
                        });
                    } catch (pubErr) {
                        console.error(`[NetworkLoss] Failed to publish CALL_TERMINATED for call ${callId}:`, pubErr.message);
                    }
                }, 20_000);

                networkLossTimers.set(key, { warnTimer, terminateTimer });

            } else if (state === 'active') {
                // Customer reconnected — cancel pending termination.
                const timers = networkLossTimers.get(key);
                if (timers) {
                    clearTimeout(timers.warnTimer);
                    clearTimeout(timers.terminateTimer);
                    networkLossTimers.delete(key);
                }

                await callLifecycleLogger.logCustomerNetworkReconnected(callId, businessId, agentId, {
                    detection_method: 'silence_watchdog',
                });
            }
        } catch (err) {
            console.error(`[EventBus] customer:media:state lifecycle log failed for call ${callId}:`, err.message);
        }
    });
}
