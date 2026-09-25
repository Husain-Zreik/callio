// Queues are where calls wait for an agent. A channel routes inbound calls
// into its inbound queue; IVR transfer nodes and agent transfers can target a
// queue. Replaces midlr's per-business routing settings
// (businesses.call_settings), has_call_center and user_groups.
//
// Strategies — which member is offered the next call:
//   RING_ALL     every available member at once; first to accept wins
//   ROUND_ROBIN  one available member at a time, rotating
//   PRIORITY     lowest queue_members.priority first; round-robin within a tier
//
// midlr's model maps onto this as:
//   non-call-center business  -> RING_ALL queue, max_active_calls = 1
//   QUEUE                     -> ROUND_ROBIN
//   PRIORITY / AGENT_ORDER    -> PRIORITY, priority = position in the list
//   PRIORITY / GROUP_LEAD_FIRST -> PRIORITY, leads = 1, other members = 2
//   RECEPTIONIST agent/group  -> a queue whose only members are the
//                                receptionist(s) (the call waits for them)
export async function up(knex) {
    await knex.schema.createTable("queues", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("tenant_id").unsigned().notNullable();
        table.string("external_ref", 191).nullable();
        table.string("name").notNullable();

        table.enum("strategy", ["RING_ALL", "ROUND_ROBIN", "PRIORITY"]).notNullable().defaultTo("ROUND_ROBIN");

        // How long one agent is offered a call before it moves on / counts as
        // missed. NULL = ring until answered or the customer hangs up.
        table.integer("ring_timeout_seconds").unsigned().nullable();
        // Cap on calls being handled from this queue at once. NULL = no cap.
        table.integer("max_active_calls").unsigned().nullable();
        // After waiting this long the call moves to overflow_queue_id (or ends
        // as TIMEOUT if none). NULL = wait indefinitely.
        table.integer("max_wait_seconds").unsigned().nullable();
        table.bigInteger("overflow_queue_id").unsigned().nullable();

        table.bigInteger("hold_audio_asset_id").unsigned().nullable();

        table.enum("status", ["ACTIVE", "DISABLED"]).notNullable().defaultTo("ACTIVE");
        table.timestamps(true, true);

        table.unique(["tenant_id", "external_ref"]);

        table.foreign("tenant_id").references("id").inTable("tenants").onDelete("CASCADE");
        table.foreign("overflow_queue_id").references("id").inTable("queues").onDelete("SET NULL");
        table.foreign("hold_audio_asset_id").references("id").inTable("audio_assets").onDelete("SET NULL");
    });

    await knex.schema.createTable("queue_members", (table) => {
        table.bigInteger("queue_id").unsigned().notNullable();
        table.bigInteger("agent_id").unsigned().notNullable();
        // Lower is offered first under the PRIORITY strategy; ignored otherwise.
        table.integer("priority").unsigned().notNullable().defaultTo(1);

        table.timestamps(true, true);

        table.primary(["queue_id", "agent_id"]);
        table.index("agent_id");

        table.foreign("queue_id").references("id").inTable("queues").onDelete("CASCADE");
        table.foreign("agent_id").references("id").inTable("agents").onDelete("CASCADE");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("queue_members");
    await knex.schema.dropTableIfExists("queues");
}
