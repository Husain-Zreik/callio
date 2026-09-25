// A tenant is an isolated routing space inside a consumer: its own agents,
// queues, channels, IVR flows and audio. For midlr, one business maps to one
// tenant. Replaces every use of midlr's `businesses` table.
//
// Routing lives in `queues`, not here. `settings` holds the few tenant-wide
// policies that aren't per queue:
//   auto_offline: { enabled, missed_threshold }  take an agent offline after
//                                                N consecutive missed offers
//   recording:    { storage_limit_bytes }        quota across all recordings
export async function up(knex) {
    await knex.schema.createTable("tenants", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("consumer_id").unsigned().notNullable();
        // The consumer's own id for this tenant (e.g. midlr's business id).
        // Opaque to Callio; used to resolve JWT claims and API requests.
        table.string("external_ref", 191).notNullable();

        table.string("name").notNullable();
        table.enum("status", ["ACTIVE", "SUSPENDED"]).notNullable().defaultTo("ACTIVE");
        table.json("settings").nullable();

        table.timestamps(true, true);

        table.unique(["consumer_id", "external_ref"]);

        table.foreign("consumer_id").references("id").inTable("consumers").onDelete("CASCADE");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("tenants");
}
