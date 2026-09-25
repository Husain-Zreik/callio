// One row per media leg of a call. connection_type says what the leg is for,
// not how it's transported — the customer leg's transport is calls.channel.
//   AGENT    (was FRONTEND) — an agent's browser/app WebRTC peer
//   CUSTOMER (was WHATSAPP) — the customer, over WhatsApp or SIP
//   MONITOR                 — a supervisor listening/whispering/barging
// One row per (call, leg type), matching the media layer, which holds one
// live peer per leg type per call: a transfer or reconnect replaces the AGENT
// row, and one supervisor monitors at a time. The unique index is also what
// makes concurrent reconnects resolve to a single row. agent_id records who
// is on the leg now. Several simultaneous monitors would need the media layer
// to key peers by leg id first; then this becomes a plain index.
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

        table.unique(["call_id", "connection_type"]);
        table.index("agent_id");

        table.foreign("call_id").references("id").inTable("calls").onDelete("CASCADE");
        table.foreign("agent_id").references("id").inTable("agents").onDelete("SET NULL");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("call_connections");
}
