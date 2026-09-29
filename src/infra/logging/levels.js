// src/infra/logging/levels.js
// Which level each component logs at.
//
// A default level plus overrides by component prefix: with
// { media: 'warn', 'channels.sip': 'debug' }, media.webrtc.Peer logs at warn and
// channels.sip.SipIngress at debug; the longest matching prefix wins. The
// configured state comes from LOG_LEVEL / LOG_LEVELS; runtime overrides
// (LogLevelControl.js) are applied on top and can be reset.
import { DEFAULT_LEVEL, SETTABLE_LEVELS } from './policy.js';

const isLevel = (l) => SETTABLE_LEVELS.includes(l);

/** "media=warn, channels.sip=debug" -> { media: 'warn', 'channels.sip': 'debug' } (invalid entries dropped). */
export function parseLevelSpec(spec) {
    const out = {};
    for (const part of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
        const [name, level] = part.split('=').map((s) => s.trim().toLowerCase());
        if (name && isLevel(level)) out[name] = level;
    }
    return out;
}

export class LevelRegistry {
    #configured;
    #active;
    #loggers = new Map();   // component -> logger whose .level we keep in sync

    constructor({ level, levels }) {
        this.#configured = { level: isLevel(level) ? level : DEFAULT_LEVEL, levels: parseLevelSpec(levels) };
        this.#active = structuredClone(this.#configured);
    }

    levelFor(component) {
        let best = null;
        for (const name of Object.keys(this.#active.levels)) {
            if ((component === name || component.startsWith(`${name}.`)) && (!best || name.length > best.length)) best = name;
        }
        return best ? this.#active.levels[best] : this.#active.level;
    }

    /** Keep this component's logger at the level the registry says. */
    track(component, log) {
        this.#loggers.set(component, log);
        log.level = this.levelFor(component);
    }

    /** Apply { level?, levels? } over the current state; a level of 'default' drops that override. */
    apply({ level, levels } = {}) {
        if (isLevel(level)) this.#active.level = level;
        for (const [name, lvl] of Object.entries(levels ?? {})) {
            if (lvl === 'default' || lvl == null) delete this.#active.levels[name];
            else if (isLevel(lvl)) this.#active.levels[name] = lvl;
        }
        this.#sync();
    }

    /** Back to LOG_LEVEL / LOG_LEVELS. */
    reset() {
        this.#active = structuredClone(this.#configured);
        this.#sync();
    }

    /** The active levels (to hand to another thread). */
    state() {
        return structuredClone(this.#active);
    }

    /** Take another thread's active levels as ours. */
    replace({ level, levels }) {
        this.#active = { level: isLevel(level) ? level : this.#active.level, levels: { ...(levels ?? {}) } };
        this.#sync();
    }

    snapshot() {
        return { ...structuredClone(this.#active), configured: structuredClone(this.#configured) };
    }

    components() {
        return [...this.#loggers.keys()].sort();
    }

    #sync() {
        for (const [name, log] of this.#loggers) log.level = this.levelFor(name);
    }
}
