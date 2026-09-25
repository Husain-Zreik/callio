// One ivr_sessions row per IVR run on a call, and one ivr_session_inputs row
// per DTMF key press within it. ivr_flow_id is SET NULL on flow deletion so
// session history survives.
export async function up(knex) {
    await knex.schema.createTable("ivr_sessions", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("call_id").unsigned().notNullable();
        table.bigInteger("ivr_flow_id").unsigned().nullable();

        table.boolean("completed").notNullable().defaultTo(false);
        table.enum("outcome", ["transferred", "hung_up", "timeout", "error"]).nullable();
        table.integer("duration").unsigned().notNullable().defaultTo(0);

        table.timestamp("started_at").nullable();
        table.timestamp("ended_at").nullable();
        table.timestamps(true, true);

        table.index("call_id");
        table.index("ivr_flow_id");

        table.foreign("call_id").references("id").inTable("calls").onDelete("CASCADE");
        table.foreign("ivr_flow_id").references("id").inTable("ivr_flows").onDelete("SET NULL");
    });

    await knex.schema.createTable("ivr_session_inputs", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("ivr_session_id").unsigned().notNullable();
        table.string("node_name").notNullable();
        table.string("input").notNullable();

        table.timestamp("pressed_at").nullable();
        table.timestamps(true, true);

        table.index(["ivr_session_id", "node_name"]);

        table.foreign("ivr_session_id").references("id").inTable("ivr_sessions").onDelete("CASCADE");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("ivr_session_inputs");
    await knex.schema.dropTableIfExists("ivr_sessions");
}
