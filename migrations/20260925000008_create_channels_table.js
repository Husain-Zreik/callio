// A customer-facing line a tenant receives and places calls on. Replaces
// midlr's business_numbers (and businesses.token for WhatsApp credentials).
//
//   WHATSAPP: address = the business phone number; provider_account_id =
//             Meta phone_number_id (what inbound webhooks resolve by);
//             credentials = { access_token }.
//   SIP:      address = the DID (E.164) — what inbound INVITEs resolve by;
//             sip_trunk_id = the trunk it arrives on / dials out through.
export async function up(knex) {
    await knex.schema.createTable("channels", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("tenant_id").unsigned().notNullable();
        table.string("external_ref", 191).nullable();

        table.enum("type", ["WHATSAPP", "SIP"]).notNullable();
        // Shown to agents as the line the call came in on / goes out from.
        table.string("display_name").nullable();
        table.string("address", 50).notNullable();
        table.string("provider_account_id", 191).nullable();
        table.bigInteger("sip_trunk_id").unsigned().nullable();
        // Encrypted JSON at the application layer.
        table.text("credentials").nullable();

        // Where inbound calls wait for an agent when no IVR flow takes them.
        table.bigInteger("inbound_queue_id").unsigned().nullable();
        table.boolean("recording_enabled").notNullable().defaultTo(false);

        table.enum("status", ["ACTIVE", "DISABLED"]).notNullable().defaultTo("ACTIVE");
        table.timestamps(true, true);

        table.unique(["tenant_id", "external_ref"]);
        table.unique(["type", "address"]);
        table.unique(["type", "provider_account_id"]);

        table.foreign("tenant_id").references("id").inTable("tenants").onDelete("CASCADE");
        table.foreign("sip_trunk_id").references("id").inTable("sip_trunks").onDelete("SET NULL");
        table.foreign("inbound_queue_id").references("id").inTable("queues").onDelete("SET NULL");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("channels");
}
