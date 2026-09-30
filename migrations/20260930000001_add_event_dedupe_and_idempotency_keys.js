// Two guarantees for consumers:
//
// webhook_deliveries.dedupe_key — "<call_id>:<event_type>" for the events a
// call has at most once (call.created, call.answered, call.ended), NULL for
// the rest. Unique, so the database — not a flag set before the write — is
// what keeps several workers from writing the same transition twice, and a
// failed write can simply be retried. The (consumer_id, id) index serves
// GET /v1/events (newest first, before_id paging).
//
// api_idempotency_keys — the Idempotency-Key header on Management API POSTs.
// One row per (consumer, key): the request's fingerprint and, once it has
// finished, the response to replay. Rows expire after 24 h.
export async function up(knex) {
    await knex.schema.alterTable("webhook_deliveries", (table) => {
        table.string("dedupe_key", 191).nullable().unique().after("event_type");
        table.index(["consumer_id", "id"]);
    });

    await knex.schema.createTable("api_idempotency_keys", (table) => {
        table.bigIncrements("id").unsigned().primary();
        table.bigInteger("consumer_id").unsigned().notNullable();
        table.string("idempotency_key", 255).notNullable();
        // SHA-256 of method, path and body: the same key with a different
        // request is refused.
        table.string("request_hash", 64).notNullable();
        table.enum("status", ["IN_PROGRESS", "COMPLETED"]).notNullable().defaultTo("IN_PROGRESS");
        table.smallint("response_status").unsigned().nullable();
        table.json("response_body").nullable();
        table.timestamp("expires_at").notNullable();
        table.timestamps(true, true);

        table.unique(["consumer_id", "idempotency_key"]);
        table.index("expires_at");
        table.foreign("consumer_id").references("id").inTable("consumers").onDelete("CASCADE");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("api_idempotency_keys");
    await knex.schema.alterTable("webhook_deliveries", (table) => {
        table.dropIndex(["consumer_id", "id"]);
        table.dropUnique(["dedupe_key"]);
        table.dropColumn("dedupe_key");
    });
}
