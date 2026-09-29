// A minimal event emitter (browser and Node, no dependencies).
export class Emitter {
    #handlers = new Map();

    on(event, fn) {
        if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
        this.#handlers.get(event).add(fn);
        return () => this.off(event, fn);
    }

    once(event, fn) {
        const off = this.on(event, (...args) => { off(); fn(...args); });
        return off;
    }

    off(event, fn) {
        this.#handlers.get(event)?.delete(fn);
    }

    emit(event, ...args) {
        for (const fn of [...(this.#handlers.get(event) ?? [])]) {
            try { fn(...args); } catch (err) { console.error(`[callio] "${event}" handler threw:`, err); }
        }
    }
}
