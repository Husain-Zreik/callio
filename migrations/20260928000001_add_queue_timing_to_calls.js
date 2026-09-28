// Queue timing for a call, so queues.ring_timeout_seconds, max_wait_seconds
// and overflow_queue_id can be enforced (core/routing/QueueTimeoutService.js):
//   queued_at       when the call entered its current queue (arrival, IVR
//                   transfer, overflow). max_wait_seconds counts from here.
//   offered_at      when the current offer to calls.agent_id started; NULL
//                   while no agent is offered it, and once the offered agent
//                   starts answering. ring_timeout_seconds counts from here.
//   overflow_count  how many times the call overflowed to another queue —
//                   bounds overflow chains that loop back on themselves.
export async function up(knex) {
    await knex.schema.alterTable("calls", (table) => {
        table.timestamp("queued_at").nullable().after("ringing_at");
        table.timestamp("offered_at").nullable().after("queued_at");
        table.tinyint("overflow_count").unsigned().notNullable().defaultTo(0).after("offered_at");
        // The timeout scan: ringing calls by queue and offer/queue time.
        table.index(["status", "queue_id", "offered_at"]);
        table.index(["status", "queue_id", "queued_at"]);
    });
}

export async function down(knex) {
    await knex.schema.alterTable("calls", (table) => {
        table.dropIndex(["status", "queue_id", "offered_at"]);
        table.dropIndex(["status", "queue_id", "queued_at"]);
        table.dropColumn("queued_at");
        table.dropColumn("offered_at");
        table.dropColumn("overflow_count");
    });
}
