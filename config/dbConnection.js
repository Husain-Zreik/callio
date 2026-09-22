// MySQL2 connection pool with transparent stale-connection recovery.
// execute() retries once on PROTOCOL_CONNECTION_LOST / ECONNRESET so callers
// never need to handle dead-connection errors themselves.
// getConnection() ping-validates before returning — prevents stale connections
// from entering a transaction. Pool size is tuned via DB_POOL_LIMIT in .env.
import mysql from 'mysql2/promise';
import { config } from './envConfig.js';

const pool = mysql.createPool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
    waitForConnections: true,
    connectionLimit: config.database.poolLimit,
    queueLimit: 1000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
});

// mysql2 pool does not validate connections before lending them out.
// MySQL's wait_timeout (server-side) closes idle connections at the
// application-protocol layer regardless of TCP keepalive — the pool
// has no way to know until the first query on a dead connection fails.
// These two wrappers make stale-connection recovery transparent to all
// callers: the broken connection is removed from the pool on the first
// failure, so the retry always gets a fresh one.

const isStale = (err) =>
    err.code === 'PROTOCOL_CONNECTION_LOST' ||
    err.code === 'ECONNRESET' ||
    // MySQL2 actual message: "The client was disconnected by the server because of inactivity."
    // Note "by the server" — "disconnected by server" (no "the") does not match.
    (typeof err.message === 'string' && err.message.includes('disconnected by'));

const _execute = pool.execute.bind(pool);
pool.execute = async (sql, params) => {
    try {
        return await _execute(sql, params);
    } catch (err) {
        if (isStale(err)) return await _execute(sql, params);
        throw err;
    }
};

// pool.query() is used by some repositories and was previously unwrapped.
const _query = pool.query.bind(pool);
pool.query = async (sql, params) => {
    try {
        return await _query(sql, params);
    } catch (err) {
        if (isStale(err)) return await _query(sql, params);
        throw err;
    }
};

// getConnection() is used for explicit transactions (AgentRepository).
// Ping-validate before handing the connection to the caller so a stale
// connection is never passed into a beginTransaction() call.
const _getConnection = pool.getConnection.bind(pool);
pool.getConnection = async () => {
    const conn = await _getConnection();
    try {
        await conn.ping();
        return conn;
    } catch (_) {
        conn.release();
        return await _getConnection();
    }
};

export default pool;
