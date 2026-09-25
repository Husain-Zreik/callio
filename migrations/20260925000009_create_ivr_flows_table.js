// IVR flow definitions. Replaces midlr's ivr_menus.
//
// structure: the flow graph the IVR engine executes. schema_version 1 is the
// graph format inherited from midlr ({ nodes[], edges[] }; node types
// ivr_start/ivr_menu/ivr_play/ivr_transfer/ivr_hangup; edge sourceHandle =
// DTMF digit). Bump the version when Callio's format changes so the engine
// can read old flows. Ids inside nodes are Callio ids: audio -> audio_assets,
// transfer targets -> queues / agents.
//
// Selection on an inbound call: channel-specific flows before tenant-wide
// ones (channel_id NULL), then trigger_priority ascending, then most recently
// updated; the first whose trigger_condition holds wins. Conditions are
// evaluated against the members of the channel's inbound queue.
export async function up(knex) {
    await knex.schema.createTable("ivr_flows", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("tenant_id").unsigned().notNullable();
        table.bigInteger("channel_id").unsigned().nullable();
        table.string("external_ref", 191).nullable();

        table.string("name").notNullable();
        table.integer("schema_version").unsigned().notNullable().defaultTo(1);
        table.json("structure").notNullable();

        table.enum("trigger_condition", [
            "ALWAYS", "ALL_AGENTS_BUSY", "ALL_AGENTS_OFFLINE", "ALL_AGENTS_UNAVAILABLE",
        ]).notNullable().defaultTo("ALWAYS");
        table.integer("trigger_priority").notNullable().defaultTo(0);

        // Seconds to wait for DTMF input on a menu node.
        table.integer("timeout_seconds").unsigned().notNullable().defaultTo(10);
        // How long an agent may ring after an IVR transfer before the call is
        // ended as IVR_AGENT_NO_ANSWER.
        table.integer("agent_ring_timeout").unsigned().notNullable().defaultTo(60);

        table.enum("status", ["ACTIVE", "INACTIVE"]).notNullable().defaultTo("INACTIVE");
        table.timestamps(true, true);

        table.unique(["tenant_id", "external_ref"]);
        table.index(["tenant_id", "status", "channel_id", "trigger_priority"]);

        table.foreign("tenant_id").references("id").inTable("tenants").onDelete("CASCADE");
        table.foreign("channel_id").references("id").inTable("channels").onDelete("CASCADE");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("ivr_flows");
}
