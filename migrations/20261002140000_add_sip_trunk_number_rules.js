// Per-trunk number formats (docs/direct-lines.md, A5). Some carriers send the
// dialled number and the caller in national format ("070123456") rather than
// E.164; number_rules says how to read them on this trunk:
//   { "country_code": "961", "national_prefix": "0" }
// A number without '+' / '00' that doesn't start with the country code is
// national: the national prefix is stripped and the country code prepended
// (src/channels/sip/sipAddress.js → applyNumberRules). NULL = numbers arrive
// in E.164 (or international without '+'), as before.
export async function up(knex) {
    await knex.schema.alterTable("sip_trunks", (table) => {
        table.json("number_rules").nullable().after("inbound_source_cidrs");
    });
}

export async function down(knex) {
    await knex.schema.alterTable("sip_trunks", (table) => {
        table.dropColumn("number_rules");
    });
}
