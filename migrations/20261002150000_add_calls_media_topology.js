// How a call's media runs (docs/direct-lines.md, Part B), chosen when the call
// is created from what it can need (core/media/MediaTopology.js):
//   ROOM    a FreeSWITCH room: IVR, queues, hold music, recording, whisper/barge
//   DIRECT  rtpengine alone bridges the customer and the agent (a personal
//           line's plain 1:1 call)
// It never changes during the call; reports read it.
export async function up(knex) {
    await knex.schema.alterTable("calls", (table) => {
        table.enum("media_topology", ["ROOM", "DIRECT"]).notNullable().defaultTo("ROOM").after("state");
    });
}

export async function down(knex) {
    await knex.schema.alterTable("calls", (table) => {
        table.dropColumn("media_topology");
    });
}
