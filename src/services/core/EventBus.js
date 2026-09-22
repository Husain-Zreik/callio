import EventEmitter from 'events';

class EventBus extends EventEmitter {
    constructor() {
        super();
        // Up to 10 concurrent calls/worker × ~15 listeners per call across all event types.
        // Default of 10 would trigger false MaxListenersExceeded warnings under load.
        this.setMaxListeners(200);
    }
}

export default new EventBus();
