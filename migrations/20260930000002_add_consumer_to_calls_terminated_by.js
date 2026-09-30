// calls.terminated_by gains CONSUMER: the consumer's backend ended the call
// (POST /v1/calls/{id}/terminate). Before, that was recorded as AGENT, so a
// consumer couldn't tell its own hang-up from an agent's.
const WITH = "'AGENT','CUSTOMER','PROVIDER','SYSTEM','CONSUMER'";
const WITHOUT = "'AGENT','CUSTOMER','PROVIDER','SYSTEM'";

export async function up(knex) {
    await knex.raw(`ALTER TABLE calls MODIFY COLUMN terminated_by ENUM(${WITH}) NULL`);
}

export async function down(knex) {
    await knex.raw("UPDATE calls SET terminated_by = 'AGENT' WHERE terminated_by = 'CONSUMER'");
    await knex.raw(`ALTER TABLE calls MODIFY COLUMN terminated_by ENUM(${WITHOUT}) NULL`);
}
