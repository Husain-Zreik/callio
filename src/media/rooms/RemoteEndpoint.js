// src/media/rooms/RemoteEndpoint.js
// A leg's FreeSWITCH endpoint as seen by a worker that took the call over
// from a dead one: it has no drachtio-fsmrf Endpoint object (that died with
// the worker that created it), only what the room snapshot kept — the channel
// uuid and drachtio's dialog id. The same surface RoomMedia uses, driven
// through what works from any worker (docs/media-architecture.md):
//   modify / destroy   re-INVITE / BYE inside the dialog, by its id
//   play               uuid_broadcast, done at PLAYBACK_STOP
//   set                uuid_setvar
//   dtmf / destroy     FreeSWITCH events filtered to the channel (FreeSwitch.watch)
//   join               uuid_transfer into the conference, member id from its list
import { EventEmitter } from 'events';
import { drachtio } from '../../infra/sip/Drachtio.js';
import { freeSwitch } from './FreeSwitch.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('media.rooms.RemoteEndpoint');

const PLAY_TIMEOUT_MS = 10 * 60_000;

export class RemoteEndpoint extends EventEmitter {
    constructor({ uuid, dialogId }) {
        super();
        this.uuid = uuid;
        this.dialog = { id: dialogId };
        this.local = { sdp: null };
        this.adopted = true;
    }

    async watch() {
        await freeSwitch.watch(this.uuid, this);
    }

    async modify(sdp) {
        const res = await drachtio.requestInDialog(this.dialog.id, {
            method: 'INVITE', body: sdp, headers: { 'Content-Type': 'application/sdp' },
        });
        if (res.status >= 300) throw new Error(`re-INVITE answered ${res.status}`);
        this.local.sdp = res.body ?? null;
        return res;
    }

    async destroy() {
        freeSwitch.unwatch(this.uuid);
        try {
            const res = await drachtio.requestInDialog(this.dialog.id, { method: 'BYE' });
            if (res.status < 300) return;
            log.debug({ status: res.status }, 'BYE refused — killing the channel');
        } catch (err) {
            log.debug({ err }, 'BYE failed — killing the channel');
        }
        await freeSwitch.api(`uuid_kill ${this.uuid}`).catch(() => { });
    }

    async play(url) {
        const done = new Promise((resolve) => {
            const timer = setTimeout(resolve, PLAY_TIMEOUT_MS);
            this.once('playback-stop', () => { clearTimeout(timer); resolve(); });
        });
        const res = await freeSwitch.api(`uuid_broadcast ${this.uuid} ${url} aleg`);
        if (!/^\+OK/.test(res)) throw new Error(`uuid_broadcast: ${res.trim()}`);
        await done;
    }

    async set(name, value) {
        await freeSwitch.api(`uuid_setvar ${this.uuid} ${name} ${value}`);
    }

    // Keypad detection was started on the channel by the worker that created
    // it and lasts as long as the channel.
    async execute() { }

    async join(room, { profile } = {}) {
        const res = await freeSwitch.api(`uuid_transfer ${this.uuid} 'conference:${room}@${profile}' inline`);
        if (!/^\+OK/.test(res)) throw new Error(`uuid_transfer: ${res.trim()}`);
        for (let i = 0; i < 20; i++) {
            const list = await freeSwitch.api(`conference ${room} list`);
            const line = list.split('\n').find((l) => l.includes(this.uuid));
            if (line) return { memberId: Number(line.split(';')[0]) };
            await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('Joined the conference but no member appeared');
    }
}
