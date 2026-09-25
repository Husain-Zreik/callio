// A consumer is one integrating product (midlr, or any future one): the unit
// of API authentication, agent-token signing and outbound event delivery.
// Everything else hangs off a tenant, which belongs to exactly one consumer.
//
// Secret-bearing columns hold ciphertext encrypted by the application, never
// plaintext — they are TEXT because ciphertext is longer than the secret.
export async function up(knex) {
    await knex.schema.createTable("consumers", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.string("name").notNullable();
        table.string("slug", 64).notNullable().unique();
        table.enum("status", ["ACTIVE", "SUSPENDED"]).notNullable().defaultTo("ACTIVE");

        // Where Callio POSTs call events; deliveries are queued in webhook_deliveries.
        table.string("event_webhook_url", 512).nullable();
        table.text("event_webhook_secret").nullable();

        // Optional pre-ring enrichment hook (customer name, refs, reject).
        // Called with a short timeout; failures never block the call.
        table.string("lookup_url", 512).nullable();

        // FCM service account, APNs VoIP key + bundle id, OneSignal app id/key.
        // Encrypted JSON; shape validated by the push services, not the schema.
        table.text("push_credentials").nullable();

        table.timestamps(true, true);
    });

    // Server-to-server API keys. Several may be active at once so a key can be
    // rotated without downtime. Only a SHA-256 hash is stored; the key is shown
    // once at creation. key_prefix is the first characters, for identifying a
    // key in logs/UI without revealing it.
    await knex.schema.createTable("consumer_api_keys", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("consumer_id").unsigned().notNullable();
        table.string("name").nullable();
        table.string("key_prefix", 16).notNullable();
        table.string("key_hash", 64).notNullable().unique();

        table.timestamp("last_used_at").nullable();
        table.timestamp("expires_at").nullable();
        table.timestamp("revoked_at").nullable();
        table.timestamps(true, true);

        table.index("consumer_id");

        table.foreign("consumer_id").references("id").inTable("consumers").onDelete("CASCADE");
    });

    // Secrets the consumer signs agent socket JWTs with (HS256). The JWT's
    // `kid` header selects the key, so a new one can be added before the old
    // one is revoked.
    await knex.schema.createTable("consumer_signing_keys", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("consumer_id").unsigned().notNullable();
        table.string("kid", 64).notNullable();
        table.text("secret").notNullable();

        table.timestamp("revoked_at").nullable();
        table.timestamps(true, true);

        table.unique(["consumer_id", "kid"]);

        table.foreign("consumer_id").references("id").inTable("consumers").onDelete("CASCADE");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("consumer_signing_keys");
    await knex.schema.dropTableIfExists("consumer_api_keys");
    await knex.schema.dropTableIfExists("consumers");
}
