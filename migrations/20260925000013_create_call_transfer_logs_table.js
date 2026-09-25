// One row per transfer of a call — to a specific agent (to_agent_id) or into
// a queue (to_queue_id, to_agent_id filled once someone accepts). Supervisors
// are agents in Callio, so the initiator is an agents.id too.
export async function up(knex) {
    await knex.schema.createTable("call_transfer_logs", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("call_id").unsigned().notNullable();
        table.bigInteger("from_agent_id").unsigned().nullable();
        table.bigInteger("to_agent_id").unsigned().nullable();
        table.bigInteger("to_queue_id").unsigned().nullable();
        table.bigInteger("initiated_by_agent_id").unsigned().nullable();
        table.enum("initiated_by_type", ["agent", "supervisor", "system"]).notNullable().defaultTo("system");

        table.timestamp("transferred_at").notNullable();
        table.timestamp("accepted_at").nullable();
        table.integer("acceptance_duration_seconds").unsigned().nullable();

        table.timestamps(true, true);

        table.index(["call_id", "to_agent_id", "accepted_at"]);
        table.index(["from_agent_id", "to_agent_id"]);
        table.index("to_queue_id");
        table.index("initiated_by_agent_id");
        table.index("transferred_at");

        table.foreign("call_id").references("id").inTable("calls").onDelete("CASCADE");
        table.foreign("from_agent_id").references("id").inTable("agents").onDelete("SET NULL");
        table.foreign("to_agent_id").references("id").inTable("agents").onDelete("SET NULL");
        table.foreign("to_queue_id").references("id").inTable("queues").onDelete("SET NULL");
        table.foreign("initiated_by_agent_id").references("id").inTable("agents").onDelete("SET NULL");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("call_transfer_logs");
}
