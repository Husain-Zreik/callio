// src/channels/whatsapp/WhatsAppWebhookTranslator.js
// Meta's WhatsApp Calling webhooks → core/channels/ChannelIngress.js. This is
// the only code that knows Meta's payload shape: it resolves the line from
// metadata.phone_number_id, turns `calls` (connect/terminate) and call
// `statuses` into ingress events, and converts Meta's addresses, unix-second
// timestamps and error codes. Every call decision is made by the ingress.
import ChannelRepository from '../../persistence/ChannelRepository.js';
import TenantRepository from '../../persistence/TenantRepository.js';
import { channelIngress } from '../../core/channels/ChannelIngress.js';
import { Channel, CustomerAddressType, TerminatedBy } from '../../core/constants/CallConstants.js';

// Max number of call/status events processed in parallel within one webhook payload.
// Prevents a single large payload from spawning unbounded concurrent DB + Redis chains.
const WEBHOOK_CONCURRENCY = 5;

// Relay-side error codes: a failure with one of these is Meta's, any other
// error code is attributed to the customer's side.
const RELAY_ERROR_CODES = new Set([138019, 138020, 138021]);

// Meta sends phone numbers as digits without '+'; Callio stores E.164.
function toE164(number) {
    if (!number) return null;
    const digits = String(number).replace(/[^\d]/g, '');
    return digits ? `+${digits}` : null;
}

// Meta timestamps are unix seconds (as strings).
function fromUnix(seconds) {
    return seconds ? new Date(parseInt(seconds, 10) * 1000) : null;
}

class WhatsAppWebhookTranslator {

    /**
     * @param {object} value    one Meta change value { metadata, calls, contacts, statuses }
     * @param {object} options
     *   consumerId  when set (forwarded webhooks), the line must belong to this consumer
     * @returns {Promise<{ accepted: boolean, reason?: string }>}
     */
    async process({ metadata, calls, contacts, statuses }, { consumerId = null } = {}) {
        // Every event in a payload is about one line (metadata.phone_number_id).
        // Resolving it once scopes all of them: the ingress drops events for
        // calls on another channel, so a payload can't touch other lines' calls.
        const channel = await ChannelRepository.findActiveByProviderAccount(Channel.WHATSAPP, metadata?.phone_number_id);
        if (!channel) {
            console.warn(`[WhatsApp:webhook] No active WhatsApp channel for phone_number_id=${metadata?.phone_number_id} — payload ignored`);
            return { accepted: false, reason: 'unknown_channel' };
        }
        if (consumerId != null && String(await TenantRepository.getConsumerId(channel.tenant_id)) !== String(consumerId)) {
            console.warn(`[WhatsApp:webhook] Channel ${channel.id} does not belong to consumer ${consumerId} — payload rejected`);
            return { accepted: false, reason: 'channel_not_owned' };
        }

        const thunks = [];
        for (const call of Array.isArray(calls) ? calls : []) {
            thunks.push(() => this._callEvent(call, channel, contacts?.[0]).catch((err) =>
                console.error(`[WhatsApp:webhook] Error processing call ${call?.id}:`, err)
            ));
        }
        for (const status of Array.isArray(statuses) ? statuses : []) {
            if (status?.type !== 'call') continue;
            thunks.push(() => channelIngress.statusChanged(channel, {
                providerCallId: status.id,
                status: status.status,
                at: fromUnix(status.timestamp),
            }).catch((err) => console.error(`[WhatsApp:webhook] Error processing status:`, err)));
        }

        if (thunks.length) await this._runConcurrent(thunks, WEBHOOK_CONCURRENCY);
        return { accepted: true };
    }

    async _callEvent(call, channel, contact) {
        const { id: providerCallId, event } = call;

        if (event === 'terminate') {
            const errors = Array.isArray(call.errors) && call.errors.length > 0 ? call.errors : null;
            // Some error codes (138019, 138021) arrive with a non-FAILED status
            // but a populated errors array — any errors mean a failure.
            const failed = call.status === 'FAILED' || errors !== null;
            await channelIngress.callEnded(channel, {
                providerCallId,
                providerStatus: call.status ?? null,
                failed,
                // start_time is absent for pre-connect ends; end_time for some
                // failures, where `timestamp` stands in for it.
                answeredAt: fromUnix(call.start_time),
                endedAt: fromUnix(call.end_time) ?? fromUnix(call.timestamp),
                durationSec: call.duration ? parseInt(call.duration, 10) : null,
                errors,
                providerCallbackData: call.biz_opaque_callback_data ?? null,
                failureTerminatedBy: RELAY_ERROR_CODES.has(errors?.[0]?.code) ? TerminatedBy.PROVIDER : TerminatedBy.CUSTOMER,
            });
            return;
        }

        if (event !== 'connect') {
            console.warn(`[WhatsApp:webhook] Unknown call event type: ${event}`);
            return;
        }

        const { direction, session } = call;
        const sdpType = session?.sdp_type?.toLowerCase();
        if (!session?.sdp || !['offer', 'answer'].includes(sdpType)) {
            console.error(`[WhatsApp:webhook] Invalid session payload for call ${providerCallId}`);
            return;
        }

        if (direction === 'USER_INITIATED' && sdpType === 'offer') {
            // The customer is whoever Meta says is calling — a phone number, or a
            // business-scoped user id for customers who call without one.
            const bsuid = contact?.user_id ?? null;
            const e164 = toE164(call.from);
            await channelIngress.inboundCall(channel, {
                providerCallId,
                customer: {
                    address: e164 ?? bsuid,
                    addressType: e164 ? CustomerAddressType.E164 : CustomerAddressType.WHATSAPP_USER,
                    name: contact?.profile?.name ?? null,
                },
                sdpOffer: session.sdp,
                offeredAt: fromUnix(call.timestamp),
                providerMetadata: {
                    wa_id: contact?.wa_id ?? null,
                    bsuid,
                    username: contact?.username ?? contact?.profile?.username ?? null,
                },
            });
            return;
        }

        if (direction === 'BUSINESS_INITIATED' && sdpType === 'answer') {
            await channelIngress.outboundAnswered(channel, { providerCallId, sdpAnswer: session.sdp });
        }
    }

    // Worker-pool: runs `thunks` with at most `limit` executing at once.
    async _runConcurrent(thunks, limit) {
        let next = 0;
        const worker = async () => {
            while (next < thunks.length) {
                await thunks[next++]();
            }
        };
        await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, worker));
    }
}

export const whatsappWebhookTranslator = new WhatsAppWebhookTranslator();
