// Audio Callio plays: IVR prompts, queue hold audio, transfer offline/busy
// messages. Replaces midlr's media_files (type='audio') and the
// platform_settings queue-audio fallback. tenant_id NULL = platform-wide
// default available to every tenant.
export async function up(knex) {
    await knex.schema.createTable("audio_assets", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("tenant_id").unsigned().nullable();
        table.string("external_ref", 191).nullable();
        table.string("name").notNullable();

        // Same storage convention as call_recordings.
        table.string("storage_provider", 50).notNullable().defaultTo("s3");
        table.string("storage_key", 512).notNullable();
        table.string("mime_type", 100).nullable();
        table.integer("duration_seconds").unsigned().nullable();
        table.bigInteger("file_size_bytes").unsigned().nullable();

        table.timestamps(true, true);

        table.unique(["tenant_id", "external_ref"]);

        table.foreign("tenant_id").references("id").inTable("tenants").onDelete("CASCADE");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("audio_assets");
}
