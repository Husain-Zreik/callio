// One row per media leg of a call. connection_type says what the leg is for,
// not how it's transported — the customer leg's transport is calls.channel.
//   AGENT    (was FRONTEND) — an agent's browser/app WebRTC peer
//   CUSTOMER (was WHATSAPP) — the customer, over WhatsApp or SIP
//   MONITOR                 — a supervisor listening/whispering/barging
// A call can have several AGENT legs over its life (transfers) and several
// MONITOR legs at once, so legs are identified by id, with agent_id saying
// who is on it.
export async function up(knex) {
    await knex.schema.createTable("call_connections", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("call_id").unsigned().notNullable();
        table.bigInteger("agent_id").unsigned().nullable();
        table.string("device_id", 191).nullable();

        table.enum("connection_type", ["AGENT", "CUSTOMER", "MONITOR"]).notNullable();
        table.enum("connection_state", ["NEW", "CONNECTING", "CONNECTED", "DISCONNECTED", "FAILED", "CLOSED"]).notNullable().defaultTo("NEW");
        table.enum("ice_gathering_state", ["NEW", "GATHERING", "COMPLETE"]).notNullable().defaultTo("NEW");
        table.enum("ice_connection_state", ["NEW", "CHECKING", "CONNECTED", "COMPLETED", "FAILED", "DISCONNECTED", "CLOSED"]).notNullable().defaultTo("NEW");

        table.integer("ice_candidates_gathered").unsigned().notNullable().defaultTo(0);
        table.json("ice_candidates").nullable();

        table.enum("sdp_type", ["OFFER", "ANSWER"]).nullable();
        table.text("local_sdp").nullable();
        table.text("remote_sdp").nullable();
        table.json("media_types").nullable();

        table.timestamp("connected_at").nullable();
        table.timestamp("disconnected_at").nullable();
        table.timestamps(true, true);

        table.index(["call_id", "connection_type"]);
        table.index("agent_id");

        table.foreign("call_id").references("id").inTable("calls").onDelete("CASCADE");
        table.foreign("agent_id").references("id").inTable("agents").onDelete("SET NULL");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("call_connections");
}
