// src/repositories/CallChatMessageRepository.js
//
// Bridges the call-center's `calls` table to the chat timeline: WhatsApp's
// own client renders every voice/video call as a bubble in the conversation
// (missed/incoming/outgoing, with duration once answered), and this system's
// chat is otherwise driven entirely by `chat_messages`. Node and Laravel share
// one MySQL database, and Node already writes `calls` directly (CallRepository),
// so this follows the same direct-SQL convention rather than introducing a new
// Node→Laravel HTTP dependency just for this feature.
//
// One `chat_messages` row per call, created when the call starts ringing and
// updated in place when it reaches a terminal state — mirrors how a single
// `calls` row is created then finalized (see CallRepository.finalizeFromWebhook).
import connection from '../../config/dbConnection.js';
import EventBus from '../services/core/EventBus.js';
import ClientRepository from './ClientRepository.js';
import CallRepository from './CallRepository.js';

const CALL_MESSAGE_TYPE = 'call';

// createRinging/finalize are both fire-and-forget from every call site (a
// failure here must never block the call itself). That means finalize() can
// legitimately run before createRinging()'s INSERT has committed — a fast
// terminate racing a still-in-flight ring creation — which would otherwise
// find no row to patch and silently give up, stranding the bubble on
// "Calling…"/"Incoming call" forever. Tracking the in-flight promise per
// callId lets finalize() wait for it instead of assuming it already ran.
const pendingRingingByCallId = new Map();

function buildBody({ callType, direction, status, terminationReason, callDuration }) {
    const label = callType === 'VIDEO' ? 'video call' : 'voice call';

    if (status === 'FAILED' || terminationReason === 'NO_ANSWER' || terminationReason === 'TIMEOUT') {
        return direction === 'OUTBOUND' ? `Unanswered ${label}` : `Missed ${label}`;
    }
    if (terminationReason === 'REJECTED') {
        return direction === 'OUTBOUND' ? `Declined ${label}` : `Missed ${label}`;
    }
    if (terminationReason === 'CANCELLED') {
        return direction === 'OUTBOUND' ? `Cancelled ${label}` : `Missed ${label}`;
    }
    if (status === 'TERMINATED') {
        // Answered and completed — WhatsApp shows the direction, not "missed".
        return direction === 'OUTBOUND' ? `Outgoing ${label}` : `Incoming ${label}`;
    }
    // Still ringing/in progress.
    return direction === 'OUTBOUND' ? `Calling…` : `Incoming ${label}`;
    // callDuration is carried in content_json for the frontend to format;
    // not interpolated into body so the frontend stays the single source of
    // truth for time formatting (locale, "0:05" vs "5s", etc.)
    void callDuration;
}

class CallChatMessageRepository {
    // Create the initial "ringing" bubble. Returns the new chat_messages id,
    // or null if the call's client/business FKs can't support a chat row yet
    // (e.g. a phone-less caller that never resolved to a client_numbers row).
    // Registers itself in pendingRingingByCallId so a finalize() that races
    // ahead of this INSERT can wait for it instead of finding nothing.
    createRinging(call) {
        const promise = this._createRinging(call);
        const { id: callId } = call;
        if (callId != null) {
            pendingRingingByCallId.set(callId, promise);
            const clear = () => {
                if (pendingRingingByCallId.get(callId) === promise) {
                    pendingRingingByCallId.delete(callId);
                }
            };
            promise.then(clear, clear);
        }
        return promise;
    }

    async _createRinging(call) {
        const {
            id: callId,
            wacid = null,
            business_id: businessId,
            business_number_id: businessNumberId,
            client_number_id: clientNumberId,
            direction,
            type: callType = 'AUDIO',
        } = call;

        if (!businessNumberId || !clientNumberId) {
            return null;
        }

        const contentJson = {
            call_id: callId,
            wacid,
            call_type: callType,
            direction,
            status: 'RINGING',
            termination_reason: null,
            duration: 0,
            body: buildBody({ callType, direction, status: 'RINGING' }),
        };

        const [result] = await connection.execute(
            `INSERT INTO chat_messages (
                business_id, business_number_id, client_number_id,
                wamid, content_json, type, status, direction, from_app,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NOW(), NOW())`,
            [
                businessId,
                businessNumberId,
                clientNumberId,
                wacid,
                JSON.stringify(contentJson),
                CALL_MESSAGE_TYPE,
                'unread',
                direction === 'OUTBOUND' ? 'outgoing' : 'incoming',
            ],
        );

        await connection.execute(
            'UPDATE client_numbers SET latest_message_at = NOW() WHERE id = ?',
            [clientNumberId],
        );

        const chatMessageId = result.insertId;
        await this._broadcast({
            businessId,
            businessNumberId,
            clientNumberId,
            chatMessageId,
            wamid: wacid,
            contentJson,
            createdAt: new Date().toISOString(),
        });

        return chatMessageId;
    }

    // Patch the bubble in place once the call reaches a terminal state.
    // Idempotent by call_id — safe to call from every terminal path even
    // under Meta's out-of-order/duplicate webhook delivery, since it always
    // writes the same final content_json for a given call. Takes just the
    // callId (re-reads the row via CallRepository) so every terminal call
    // site in CallWebhookProcessor only needs the id + outcome, matching
    // CallRepository.finalizeFromWebhook's own shape.
    async finalize(callId, { status, terminationReason = null, callDuration = null } = {}) {
        // A fast terminate can reach here before createRinging()'s INSERT for
        // this same call has committed — wait for it so the SELECT below
        // actually finds the row instead of silently no-op'ing.
        const pending = pendingRingingByCallId.get(callId);
        if (pending) {
            await pending.catch(() => { });
        }

        const call = await CallRepository.findById(callId);
        if (!call) return;

        const {
            business_id: businessId,
            business_number_id: businessNumberId,
            client_number_id: clientNumberId,
            direction,
            type: callType = 'AUDIO',
            wacid = null,
        } = call;

        // Prefer the caller-supplied duration (fresher than what's on the row
        // in a race), otherwise fall back to the row's own call_duration —
        // never silently zero out a real duration a caller didn't pass.
        const resolvedDuration = callDuration != null ? callDuration : (call.call_duration || 0);

        if (!businessNumberId || !clientNumberId) {
            return;
        }

        const [rows] = await connection.execute(
            `SELECT id FROM chat_messages
             WHERE type = ? AND JSON_EXTRACT(content_json, '$.call_id') = ?
             LIMIT 1`,
            [CALL_MESSAGE_TYPE, callId],
        );
        const chatMessageId = rows[0]?.id;
        if (!chatMessageId) {
            // No ringing bubble was created (e.g. FKs unresolved at ring time) —
            // nothing to finalize in the chat timeline.
            return;
        }

        const contentJson = {
            call_id: callId,
            wacid,
            call_type: callType,
            direction,
            status,
            termination_reason: terminationReason,
            duration: resolvedDuration,
            body: buildBody({ callType, direction, status, terminationReason, callDuration: resolvedDuration }),
        };

        await connection.execute(
            `UPDATE chat_messages
             SET content_json = ?, status = 'read', updated_at = NOW()
             WHERE id = ?`,
            [JSON.stringify(contentJson), chatMessageId],
        );

        await this._broadcast({
            businessId,
            businessNumberId,
            clientNumberId,
            chatMessageId,
            wamid: wacid,
            contentJson,
            createdAt: new Date().toISOString(),
        });
    }

    async _broadcast({ businessId, businessNumberId, clientNumberId, chatMessageId, wamid, contentJson, createdAt }) {
        let clientUuid = null;
        try {
            const client = await ClientRepository.findById(clientNumberId);
            clientUuid = client?.uuid || null;
        } catch (err) {
            console.warn('[CallChatMessageRepository] Failed to resolve client uuid', err?.message);
        }

        EventBus.emit('chat:call-update', {
            businessId,
            businessNumberId,
            clientNumberId,
            clientUuid,
            chatMessageId,
            wamid,
            type: CALL_MESSAGE_TYPE,
            contentJson,
            createdAt,
        });
    }
}

export default new CallChatMessageRepository();
