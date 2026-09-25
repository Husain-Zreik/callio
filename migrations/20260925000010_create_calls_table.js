// One row per call between one of a tenant's channels and one customer.
//
// The customer is stored once, the same way in both directions:
// customer_address + customer_address_type say how to reach them, and
// channel_address snapshots our side of the line (the channel row can
// change later; the call's history shouldn't). Other provider-specific
// identifiers (e.g. a WhatsApp username alongside the phone number) go in
// metadata.
//
// external_ref / consumer_metadata belong to the consumer: Callio stores and
// returns them but never reads them. `metadata` is Callio's own.
//
// Differences from midlr's production `calls` table:
//   business_id -> tenant_id; user_id -> agent_id; business_number_id ->
//   channel_id; ivr_menu_id -> ivr_flow_id; + queue_id
//   client_number_id and caller_*/callee_* -> customer_* + channel_address
//   wacid -> provider_call_id, unique per `channel` (Meta call id / SIP Call-ID)
//   callback_data -> failure_details
//   is_billed / is_billable dropped (never read; billing is the consumer's)
//   terminated_by BUSINESS/CLIENT/WHATSAPP -> AGENT/CUSTOMER/PROVIDER
//   termination_reason WHATSAPP_TRIGGER_FAILED -> PROVIDER_TRIGGER_FAILED
export async function up(knex) {
    await knex.schema.createTable("calls", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("tenant_id").unsigned().notNullable();
        table.bigInteger("channel_id").unsigned().nullable();
        table.bigInteger("queue_id").unsigned().nullable();
        table.bigInteger("agent_id").unsigned().nullable();
        table.bigInteger("ivr_flow_id").unsigned().nullable();

        // Denormalised from channels.type so a call keeps its transport even
        // if the channel row is later removed.
        table.enum("channel", ["WHATSAPP", "SIP"]).notNullable();
        table.string("channel_address", 50).nullable();
        table.string("provider_call_id", 191).nullable();

        table.string("customer_address", 191).nullable();
        // E164: a phone number. WHATSAPP_USER: a WhatsApp business-scoped user
        // id, for customers reachable without a phone number. SIP_URI: a
        // sip: address that isn't a plain number.
        table.enum("customer_address_type", ["E164", "WHATSAPP_USER", "SIP_URI"]).nullable();
        table.string("customer_name").nullable();

        table.string("external_ref", 191).nullable();
        table.json("consumer_metadata").nullable();

        table.enum("type", ["AUDIO", "VIDEO"]).notNullable().defaultTo("AUDIO");
        table.enum("direction", ["INBOUND", "OUTBOUND"]).notNullable().defaultTo("INBOUND");
        table.enum("status", ["INITIATED", "RINGING", "IN_PROGRESS", "TERMINATED", "FAILED"]).notNullable().defaultTo("INITIATED");
        table.enum("state", ["IVR", "QUEUE", "ACTIVE", "ON_HOLD"]).nullable();

        table.enum("termination_reason", [
            "COMPLETED", "CANCELLED", "REJECTED", "BUSY", "NO_ANSWER", "TIMEOUT",
            "AGENT_DISCONNECTED", "AGENT_MEDIA_NOT_READY", "SYSTEM_ERROR",
            "NETWORK_ERROR", "PROVIDER_ERROR", "PROVIDER_TRIGGER_FAILED",
            "SERVICE_MAINTENANCE", "CUSTOMER_NETWORK_LOSS", "IVR_AGENT_NO_ANSWER",
        ]).nullable();
        table.enum("terminated_by", ["AGENT", "CUSTOMER", "PROVIDER", "SYSTEM"]).nullable();

        table.timestamp("ringing_at").nullable();
        table.timestamp("answered_at").nullable();
        table.timestamp("ended_at").nullable();

        table.integer("ringing_duration").unsigned().notNullable().defaultTo(0);
        table.integer("call_duration").unsigned().notNullable().defaultTo(0);
        table.integer("queue_duration").unsigned().notNullable().defaultTo(0);
        table.integer("on_hold_duration").unsigned().notNullable().defaultTo(0);

        // { errors: [{ code, title, details, source }], provider_callback_data }
        table.json("failure_details").nullable();
        table.json("metadata").nullable();

        table.timestamps(true, true);

        table.unique(["channel", "provider_call_id"]);
        table.index(["tenant_id", "status", "created_at"]);
        table.index(["tenant_id", "external_ref"]);
        table.index(["tenant_id", "customer_address"]);
        // Unassigned-queue scans: queue + status + no agent, oldest ringing first.
        table.index(["queue_id", "status", "agent_id", "ringing_at"]);
        table.index(["agent_id", "status"]);
        table.index("channel_id");
        table.index("ivr_flow_id");

        table.foreign("tenant_id").references("id").inTable("tenants").onDelete("CASCADE");
        table.foreign("channel_id").references("id").inTable("channels").onDelete("SET NULL");
        table.foreign("queue_id").references("id").inTable("queues").onDelete("SET NULL");
        table.foreign("agent_id").references("id").inTable("agents").onDelete("SET NULL");
        table.foreign("ivr_flow_id").references("id").inTable("ivr_flows").onDelete("SET NULL");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("calls");
}
