// knexfile.js — Knex CLI config for Callio's own database. See
// migrations/README.md for the data model.
//
// Reuses config/envConfig.js for connection details, same as every other
// file in this repo — never read process.env directly. Unlike
// ecosystem.config.cjs (which is CJS and predates the app process, so it
// can't import the ESM config module), this file is plain ESM and can.
import { config } from "./config/envConfig.js";

export default {
    client: "mysql2",
    connection: {
        host: config.database.host,
        port: config.database.port,
        user: config.database.user,
        password: config.database.password,
        database: config.database.database,
        charset: "utf8mb4",
        // UTC, same as config/dbConnection.js.
        timezone: "Z",
    },
    pool: {
        min: 0,
        max: config.database.poolLimit,
        afterCreate: (conn, done) => conn.query("SET time_zone = '+00:00'", (err) => done(err, conn)),
    },
    migrations: {
        directory: "./migrations",
        tableName: "knex_migrations",
    },
};
