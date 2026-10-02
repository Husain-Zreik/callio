// Personal lines (docs/direct-lines.md, A2). A channel with owner_agent_id is
// that agent's own line: inbound calls ring them, and only they may call out
// from it. Without one it is a shared line routed by its queue / IVR. A line
// has an owner or an inbound queue, never both (the Management API keeps
// that). ring_timeout_seconds: how long a personal line rings its owner before
// the call ends NO_ANSWER (NULL = the default, 30 s).
export async function up(knex) {
    await knex.schema.alterTable("channels", (table) => {
        table.bigInteger("owner_agent_id").unsigned().nullable().after("inbound_queue_id");
        table.integer("ring_timeout_seconds").unsigned().nullable().after("owner_agent_id");
        table.foreign("owner_agent_id").references("agents.id").onDelete("SET NULL");
        table.index(["owner_agent_id"]);
    });
}

export async function down(knex) {
    await knex.schema.alterTable("channels", (table) => {
        table.dropForeign(["owner_agent_id"]);
        table.dropIndex(["owner_agent_id"]);
        table.dropColumn("ring_timeout_seconds");
        table.dropColumn("owner_agent_id");
    });
}
