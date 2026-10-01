// Who is in a call: the customer, the agents and the supervisors, each with
// when they joined and left (docs/media-architecture.md#data-model). A call is
// a room, so there is no limit per kind: a transfer leaves one AGENT row and
// opens another, and several supervisors can be in at once. A row is open
// while left_at is NULL; at most one open row per (call, kind, agent) is kept
// by the writes (core/calls/CallParticipants.js), not by an index, because
// MySQL has no partial unique index.
//
// media_node is the media server the participant's leg runs on, once media
// runs on one (filled from stage 3 of the media migration).
export async function up(knex) {
    await knex.schema.createTable("call_participants", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("call_id").unsigned().notNullable();
        table.bigInteger("tenant_id").unsigned().notNullable();
        table.enum("kind", ["CUSTOMER", "AGENT", "SUPERVISOR"]).notNullable();
        table.bigInteger("agent_id").unsigned().nullable();
        table.string("device_id", 191).nullable();
        table.string("media_node", 191).nullable();

        table.timestamp("joined_at", { precision: 3 }).notNullable();
        table.timestamp("left_at", { precision: 3 }).nullable();
        table.string("leave_reason", 32).nullable();
        table.timestamps(true, true);

        table.index(["call_id", "left_at"]);
        table.index(["agent_id", "left_at"]);
        table.index(["tenant_id", "joined_at"]);

        table.foreign("call_id").references("id").inTable("calls").onDelete("CASCADE");
        table.foreign("tenant_id").references("id").inTable("tenants").onDelete("CASCADE");
        table.foreign("agent_id").references("id").inTable("agents").onDelete("SET NULL");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("call_participants");
}
