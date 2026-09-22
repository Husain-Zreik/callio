// services/EventEmitter.js
export class EventEmitter {
    constructor() {
        this.events = new Map();
    }

    on(event, callback) {
        if (!this.events.has(event)) this.events.set(event, []);
        this.events.get(event).push(callback);
    }

    off(event, callback) {
        if (!this.events.has(event)) return;

        if (callback) {
            const listeners = this.events.get(event);
            const index = listeners.indexOf(callback);
            if (index > -1) listeners.splice(index, 1);
        } else {
            this.events.delete(event);
        }
    }

    emit(event, data) {
        if (!this.events.has(event)) return;
        this.events.get(event).forEach(cb => {
            try {
                const result = cb(data);
                // If the listener returned a Promise (async function), catch rejections
                // so they are logged rather than becoming unhandled rejections that can
                // crash the process or silently drop critical operations.
                if (result && typeof result.catch === 'function') {
                    result.catch(err =>
                        console.error(`[EventEmitter] Unhandled async error in '${event}' listener:`, err?.message ?? err)
                    );
                }
            } catch (err) {
                console.error(`[EventEmitter] Unhandled sync error in '${event}' listener:`, err?.message ?? err);
            }
        });
    }

    removeAllListeners(event) {
        if (event) {
            this.events.delete(event);
        } else {
            this.events.clear();
        }
    }
}
