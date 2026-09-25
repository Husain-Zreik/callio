// Outbox for events Callio sends to a consumer's event_webhook_url
// (call.ringing, call.answered, call.ended, recording.completed, ...). The
// event is written here in the same step as the change that caused it, then
// delivered and retried with backoff by a worker, so a consumer outage never
// loses events. event_id is sent with the payload so the consumer can
// discard duplicates.
export async function up(knex) {
    await knex.schema.createTable("webhook_deliveries", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("consumer_id").unsigned().notNullable();
        table.bigInteger("tenant_id").unsigned().nullable();
        table.bigInteger("call_id").unsigned().nullable();

        table.uuid("event_id").notNullable().unique();
        table.string("event_type", 64).notNullable();
        table.json("payload").notNullable();

        table.enum("status", ["PENDING", "DELIVERED", "FAILED"]).notNullable().defaultTo("PENDING");
        table.integer("attempts").unsigned().notNullable().defaultTo(0);
        table.timestamp("next_attempt_at").notNullable().defaultTo(knex.fn.now());
        table.integer("last_response_status").unsigned().nullable();
        table.text("last_error").nullable();
        table.timestamp("delivered_at").nullable();

        table.timestamps(true, true);

        table.index(["status", "next_attempt_at"]);
        table.index(["consumer_id", "created_at"]);
        table.index("call_id");

        table.foreign("consumer_id").references("id").inTable("consumers").onDelete("CASCADE");
        table.foreign("tenant_id").references("id").inTable("tenants").onDelete("CASCADE");
        table.foreign("call_id").references("id").inTable("calls").onDelete("SET NULL");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("webhook_deliveries");
}
