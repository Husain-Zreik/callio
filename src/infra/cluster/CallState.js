// src/infra/cluster/CallState.js
// Per-call state a worker taking a call over needs, kept outside the worker
// that runs the call: callio:call:<id>:<part> (JSON, 24 h). Parts: 'room'
// (media/rooms/RoomSnapshot.js), 'ivr' (the IVR's position). Written as the
// call changes, dropped when it ends.
import { redisBaseService } from '../redis/RedisBaseService.js';

const TTL_S = 24 * 3600;
const PARTS = ['room', 'ivr'];
const key = (callId, part) => `callio:call:${callId}:${part}`;

class CallState {
    async save(callId, part, value) {
        await redisBaseService.getClient().set(key(callId, part), JSON.stringify(value), 'EX', TTL_S);
    }

    async load(callId, part) {
        const raw = await redisBaseService.getClient().get(key(callId, part));
        return raw ? JSON.parse(raw) : null;
    }

    async drop(callId, part) {
        await redisBaseService.getClient().del(key(callId, part));
    }

    async dropAll(callId) {
        await redisBaseService.getClient().del(...PARTS.map((part) => key(callId, part)));
    }
}

export const callState = new CallState();
