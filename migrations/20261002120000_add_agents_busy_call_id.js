// Availability and busy, separately (docs/direct-lines.md, A1).
// agents.availability is the shift: AVAILABLE / OFFLINE, which only queues
// read. busy_call_id is the call holding the agent, claimed and released with
// guarded updates (persistence/AgentRepository.js); the reported status is
// ON_CALL while it is set. Nothing writes availability = 'ON_CALL' any more;
// a later migration drops the value once no worker running the old code is
// left (until then the code reads it as AVAILABLE).
//
// No foreign key: retention deletes calls, and a busy_call_id left pointing at
// a deleted or ended call is released by the cleanup loop.
export async function up(knex) {
    await knex.schema.alterTable("agents", (table) => {
        table.bigInteger("busy_call_id").unsigned().nullable().after("availability");
        table.index(["busy_call_id"]);
    });

    // An agent ON_CALL on a live call: busy with it, on shift.
    await knex.raw(`
        UPDATE agents a
        JOIN (
            SELECT agent_id, MAX(id) AS call_id FROM calls
            WHERE agent_id IS NOT NULL AND status IN ('INITIATED', 'RINGING', 'IN_PROGRESS')
            GROUP BY agent_id
        ) live ON live.agent_id = a.id
        SET a.busy_call_id = live.call_id, a.availability = 'AVAILABLE'
        WHERE a.availability = 'ON_CALL'
    `);
    // ON_CALL with no live call was stuck: the old safety net released those
    // to OFFLINE, so do the same.
    await knex.raw(`UPDATE agents SET availability = 'OFFLINE' WHERE availability = 'ON_CALL'`);
}

export async function down(knex) {
    await knex.raw(`UPDATE agents SET availability = 'ON_CALL' WHERE busy_call_id IS NOT NULL`);
    await knex.schema.alterTable("agents", (table) => {
        table.dropIndex(["busy_call_id"]);
        table.dropColumn("busy_call_id");
    });
}
