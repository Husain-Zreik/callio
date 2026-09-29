// src/infra/logging/consoleBridge.js
// console.* from libraries (Code in src/ never uses console — the e2e runner
// checks) goes into the logger as component "console", a leading "[Prefix]"
// kept as `mod`. Node's own warnings ("(node:123) …") go to "process" as warn.
import { format } from 'util';

let installed = false;

export function installConsoleBridge({ consoleLog, processLog }) {
    if (installed) return;
    installed = true;
    const bridge = (level) => (...args) => {
        const err = args.find((a) => a instanceof Error);
        let text = format(...args.filter((a) => a !== err));
        const fields = err ? { err } : {};
        const node = /^\(node:\d+\) /.exec(text);
        if (node) return processLog.warn(fields, text.slice(node[0].length));
        const prefix = /^\s*\[([^\]]{1,60})\]\s*/.exec(text);
        if (prefix) { fields.mod = prefix[1]; text = text.slice(prefix[0].length); }
        consoleLog[level](fields, text);
    };
    console.log = bridge('info');
    console.info = bridge('info');
    console.debug = bridge('debug');
    console.trace = bridge('trace');
    console.warn = bridge('warn');
    console.error = bridge('error');
}
