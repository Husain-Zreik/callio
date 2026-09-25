// Push targets for an agent's devices — one row per (device, provider).
// Callio sends incoming-call pushes itself using the consumer's
// push_credentials. Replaces midlr's user_devices, users.fcm_token and
// notification_subscriptions. Consumers register tokens through Callio's API.
//   FCM        Android + iOS data messages
//   APNS_VOIP  iOS PushKit VoIP token (CallKit ringing)
//   ONESIGNAL  web push subscription id
export async function up(knex) {
    await knex.schema.createTable("agent_push_tokens", (table) => {
        table.bigIncrements("id").unsigned().primary();

        table.bigInteger("agent_id").unsigned().notNullable();
        // Client-generated stable device id — also written to
        // call_connections.device_id to know which device answered.
        table.string("device_id", 191).notNullable();
        table.enum("platform", ["ANDROID", "IOS", "WEB"]).notNullable();
        table.enum("provider", ["FCM", "APNS_VOIP", "ONESIGNAL"]).notNullable();
        table.string("token", 512).notNullable();

        table.boolean("is_active").notNullable().defaultTo(true);
        table.timestamp("last_seen_at").nullable();
        table.timestamps(true, true);

        table.unique(["agent_id", "device_id", "provider"]);
        table.index(["agent_id", "is_active"]);

        table.foreign("agent_id").references("id").inTable("agents").onDelete("CASCADE");
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists("agent_push_tokens");
}
