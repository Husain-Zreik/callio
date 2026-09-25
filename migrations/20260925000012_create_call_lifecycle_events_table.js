// Append-only audit trail of what happened to a call. Tenant scoping comes
// through call_id -> calls.tenant_id.
//
// event_type is a string, not a MySQL ENUM: the set of events grows with
// features, and adding one shouldn't need a migration. Valid values are
// defined in code (call/constants) and validated there. Direction is already
// on the call, so event names don't need to repeat it.
export async function up(knex) {
    await knex.schema.createTable("call_lifecycle_events", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("call_id").unsigned().notNullable();
        table.bigInteger("agent_id").unsigned().nullable();
        table.string("event_type", 64).notNullable();

        table.timestamp("occurred_at").notNullable().defaultTo(knex.fn.now());
        table.integer("duration_seconds").unsigned().nullable();
        table.json("metadata").nullable();

        table.timestamps(true, true);

        table.index(["call_id", "occurred_at"]);
        table.index(["call_id", "event_type"]);
        table.index(["event_type", "occurred_at"]);
        table.index("agent_id");

        table.foreign("call_id").references("id").inTable("calls").onDelete("CASCADE");
        table.foreign("agent_id").references("id").inTable("agents").onDelete("SET NULL");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("call_lifecycle_events");
}
