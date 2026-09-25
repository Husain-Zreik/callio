// One stereo recording per call (left = customer, right = agent), written by
// the recording pipeline and uploaded to object storage. Callio owns the
// stored files, so it owns their retention too: retained_until (legal hold),
// scheduled purge, and an audit of who asked for deletion.
//
// Differences from midlr's production table: business_id removed (tenant
// comes through call_id; the storage-quota sum joins calls), recording_url
// renamed storage_key (it has held a bare S3 key since midlr's 2026-03-16
// normalisation), deletion_requested_by (a midlr users.id) replaced by the
// opaque deletion_requested_by_ref.
export async function up(knex) {
    await knex.schema.createTable("call_recordings", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("call_id").unsigned().notNullable();

        table.string("storage_provider", 50).notNullable().defaultTo("s3");
        table.string("storage_region", 50).nullable();
        table.string("storage_key", 512).nullable();
        table.bigInteger("file_size_bytes").unsigned().nullable();
        table.string("format", 20).notNullable().defaultTo("ogg");
        table.string("channel_map", 50).notNullable().defaultTo("left=customer,right=agent");
        table.integer("duration_seconds").unsigned().nullable();

        table.enum("status", [
            "recording", "processing", "completed", "failed", "pending_deletion", "purged",
        ]).notNullable().defaultTo("recording");
        table.text("error_message").nullable();

        table.timestamp("started_at").notNullable().defaultTo(knex.fn.now());
        table.timestamp("completed_at").nullable();

        table.timestamp("retained_until").nullable();
        table.timestamp("scheduled_purge_at").nullable();
        table.timestamp("purged_at").nullable();
        table.string("deletion_requested_by_ref", 191).nullable();
        table.timestamp("deletion_requested_at").nullable();

        table.timestamps(true, true);

        table.index("call_id");
        table.index(["status", "scheduled_purge_at"]);
        table.index("created_at");

        table.foreign("call_id").references("id").inTable("calls").onDelete("CASCADE");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("call_recordings");
}
