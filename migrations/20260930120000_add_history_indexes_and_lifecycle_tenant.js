// Indexes for reading a tenant's history, and a token index for push.
//
// calls (tenant_id, created_at) / (tenant_id, ended_at)
//   Listing calls (GET /calls, newest first) and the reports filter a tenant's
//   calls by time; the only tenant index, (tenant_id, status, created_at),
//   helps only when a status is given, so every page read and sorted the
//   tenant's whole history. InnoDB appends the primary key, so
//   (tenant_id, created_at) also serves ORDER BY id within a tenant.
//
// call_lifecycle_events.tenant_id + (tenant_id, occurred_at)
//   The agents report counts events in a window for one tenant; without the
//   column it read every tenant's events in the window through a join.
//   Backfilled from calls.
//
// agent_push_tokens UNIQUE (provider, token), is_active dropped
//   Registering a device and pruning a dead token look a token up by value —
//   a full table scan on every app start. One token belongs to one device.
//   is_active was never set to 0.
export async function up(knex) {
    await knex.schema.alterTable("calls", (table) => {
        table.index(["tenant_id", "created_at"]);
        table.index(["tenant_id", "ended_at"]);
    });

    await knex.schema.alterTable("call_lifecycle_events", (table) => {
        table.bigInteger("tenant_id").unsigned().nullable().after("call_id");
    });
    await knex.raw(`UPDATE call_lifecycle_events e JOIN calls c ON c.id = e.call_id SET e.tenant_id = c.tenant_id WHERE e.tenant_id IS NULL`);
    await knex.schema.alterTable("call_lifecycle_events", (table) => {
        table.index(["tenant_id", "occurred_at"]);
        table.foreign("tenant_id").references("id").inTable("tenants").onDelete("CASCADE");
    });

    // Keep the newest row of any token stored twice before making it unique.
    await knex.raw(`
        DELETE p FROM agent_push_tokens p
        JOIN agent_push_tokens newer
          ON newer.provider = p.provider AND newer.token = p.token AND newer.id > p.id`);
    await knex.schema.alterTable("agent_push_tokens", (table) => {
        table.unique(["provider", "token"]);
        table.dropIndex(["agent_id", "is_active"]);
        table.dropColumn("is_active");
    });
}

export async function down(knex) {
    await knex.schema.alterTable("agent_push_tokens", (table) => {
        table.boolean("is_active").notNullable().defaultTo(true);
        table.index(["agent_id", "is_active"]);
        table.dropUnique(["provider", "token"]);
    });
    await knex.schema.alterTable("call_lifecycle_events", (table) => {
        table.dropForeign(["tenant_id"]);
        table.dropIndex(["tenant_id", "occurred_at"]);
        table.dropColumn("tenant_id");
    });
    await knex.schema.alterTable("calls", (table) => {
        table.dropIndex(["tenant_id", "created_at"]);
        table.dropIndex(["tenant_id", "ended_at"]);
    });
}
