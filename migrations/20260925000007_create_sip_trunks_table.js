// SIP trunks: the carrier connections SIP channels (DIDs) arrive on and
// outbound SIP calls leave through. consumer_id NULL = a platform trunk
// shared by every consumer (e.g. the Digitalk trunk); otherwise a consumer
// brought its own carrier.
export async function up(knex) {
    await knex.schema.createTable("sip_trunks", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("consumer_id").unsigned().nullable();
        table.string("name").notNullable();

        table.string("host").notNullable();
        table.integer("port").unsigned().notNullable().defaultTo(5060);
        table.enum("transport", ["UDP", "TCP", "TLS"]).notNullable().defaultTo("UDP");

        // Digest auth for outbound INVITEs, if the carrier requires it.
        // Encrypted JSON { username, password }.
        table.text("credentials").nullable();
        // CIDRs inbound INVITEs from this carrier may come from.
        table.json("inbound_source_cidrs").nullable();

        table.enum("status", ["ACTIVE", "DISABLED"]).notNullable().defaultTo("ACTIVE");
        table.timestamps(true, true);

        table.foreign("consumer_id").references("id").inTable("consumers").onDelete("CASCADE");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("sip_trunks");
}
