// src/core/calls/CustomerLookup.js
// Optional pre-ring enrichment hook (docs/events.md#lookup-hook-optional-synchronous). If the
// consumer set consumers.lookup_url, Callio asks it about an inbound caller
// before ringing anyone. Bounded by a short timeout: a slow or failing
// consumer delays a call by at most LOOKUP_TIMEOUT_MS, never drops it.
import axios from 'axios';
import ConsumerRepository from '../../persistence/ConsumerRepository.js';
import TenantRepository from '../../persistence/TenantRepository.js';
import { signPayload } from '../../outbox/signing.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.calls.CustomerLookup');

const LOOKUP_TIMEOUT_MS = 1500;

class CustomerLookup {
    /**
     * @returns {Promise<{ customerName?, externalRef?, consumerMetadata?, reject: boolean }>}
     */
    async lookup(tenantId, { channel, channelAddress, customerAddress, customerAddressType, customerName }) {
        const empty = { reject: false };
        try {
            const tenant = await TenantRepository.findById(tenantId);
            if (!tenant) return empty;
            const consumer = await ConsumerRepository.findById(tenant.consumer_id);
            if (!consumer?.lookup_url) return empty;

            const body = JSON.stringify({
                tenant_ref: tenant.external_ref,
                channel,
                channel_address: channelAddress,
                customer: { address: customerAddress, address_type: customerAddressType, name: customerName ?? null },
            });
            const secret = await ConsumerRepository.getWebhookSecret(consumer.id);
            const headers = { 'Content-Type': 'application/json' };
            if (secret) headers['X-Callio-Signature'] = signPayload(secret, body);

            const response = await axios.post(consumer.lookup_url, body, {
                headers,
                timeout: LOOKUP_TIMEOUT_MS,
                maxRedirects: 0,           // like event delivery: a redirect is a failed lookup
                validateStatus: (status) => status >= 200 && status < 300,
            });
            const data = response.data ?? {};
            return {
                customerName: typeof data.customer_name === 'string' ? data.customer_name : undefined,
                externalRef: data.external_ref != null ? String(data.external_ref).slice(0, 191) : undefined,
                consumerMetadata: data.consumer_metadata && typeof data.consumer_metadata === 'object'
                    ? data.consumer_metadata : undefined,
                reject: data.action === 'reject',
            };
        } catch (err) {
            log.warn({ tenantId, err }, 'Lookup failed — continuing without it');
            return empty;
        }
    }
}

export const customerLookup = new CustomerLookup();
