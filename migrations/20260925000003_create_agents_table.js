// Anyone who handles or supervises calls in a tenant. Replaces midlr's
// `users` rows, its role/permission tables and users.call_availability.
// Only what Callio acts on is stored — name for display in call payloads;
// email and other profile data stay with the consumer.
//
// Being in the same database as `calls` is what lets the availability updates
// keep their `NOT EXISTS (active call)` guards and the
// claim-agent-and-assign-call transaction.
export async function up(knex) {
    await knex.schema.createTable("agents", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("tenant_id").unsigned().notNullable();
        // The consumer's own id for this person — the JWT `sub` claim.
        table.string("external_ref", 191).notNullable();
        table.string("name").notNullable();

        // AGENT: receives calls from the queues they're a member of.
        // SUPERVISOR: also receives supervisor broadcasts and can monitor,
        // whisper, barge and transfer.
        table.enum("role", ["AGENT", "SUPERVISOR"]).notNullable().defaultTo("AGENT");

        table.enum("availability", ["AVAILABLE", "ON_CALL", "OFFLINE"]).notNullable().defaultTo("OFFLINE");
        table.timestamp("availability_changed_at").nullable();

        table.timestamps(true, true);
        table.timestamp("deleted_at").nullable();

        table.unique(["tenant_id", "external_ref"]);
        table.index(["tenant_id", "role", "availability"]);

        table.foreign("tenant_id").references("id").inTable("tenants").onDelete("CASCADE");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("agents");
}
