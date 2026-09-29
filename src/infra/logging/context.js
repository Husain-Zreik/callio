// src/infra/logging/context.js
// Fields bound to an async flow: every record logged inside it (and in what it
// awaits) carries them. Bound once where a flow starts — call events
// (RedisPubSubService), socket events (connectionHandler), HTTP requests
// (http/accessLog.js) — so modules never repeat them.
import { AsyncLocalStorage } from 'async_hooks';

const storage = new AsyncLocalStorage();

function clean(fields) {
    return Object.fromEntries(Object.entries(fields ?? {}).filter(([, v]) => v !== undefined && v !== null));
}

/** Run fn with only these fields as context — a new flow, nothing inherited. */
export function runWithLogContext(fields, fn) {
    return storage.run(clean(fields), fn);
}

/** Run fn with these fields added to the current context. */
export function withLogContext(fields, fn) {
    return storage.run({ ...(storage.getStore() ?? {}), ...clean(fields) }, fn);
}

/** Add fields for the rest of the current flow (no-op outside one; sibling flows are unaffected). */
export function addLogContext(fields) {
    const store = storage.getStore();
    if (store) storage.enterWith({ ...store, ...clean(fields) });
}

/**
 * The current flow's fields (pino `mixin`). A copy every time: pino merges
 * each record's own fields into the object the mixin returns, so returning
 * the store itself would carry one record's fields into the next.
 */
export function currentLogContext() {
    const store = storage.getStore();
    return store ? { ...store } : {};
}
