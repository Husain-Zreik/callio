// consumers.event_types — the event types a consumer receives (a JSON array
// of names such as "call.ended"); NULL = every type. Set by the consumer with
// PUT /v1/webhook. Events of other types are not written to its outbox at
// all, so GET /v1/events lists only what it subscribed to.
export async function up(knex) {
    await knex.schema.alterTable("consumers", (table) => {
        table.json("event_types").nullable().after("event_webhook_secret");
    });
}

export async function down(knex) {
    await knex.schema.alterTable("consumers", (table) => {
        table.dropColumn("event_types");
    });
}
