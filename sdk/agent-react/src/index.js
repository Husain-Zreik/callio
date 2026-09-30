// @callio/agent-react — React bindings for @callio/agent-sdk.
//
//   <CallioProvider url=… getToken={…}>
//     <App />
//   </CallioProvider>
//
// Hooks re-render when the SDK's objects change; the objects themselves (the
// agent, calls, monitors) are the SDK's, and their actions are used as they are.
// No JSX, no build step: plain ES modules.
import { createContext, createElement, useCallback, useContext, useEffect, useReducer, useRef, useState } from 'react';
import { connect as sdkConnect } from '@callio/agent-sdk';

const CallioContext = createContext(null);

// Re-render when any of `events` fires on `emitter` (null emitter: never).
function useEmitter(emitter, events) {
    const [, bump] = useReducer((n) => n + 1, 0);
    const key = events.join('|');
    useEffect(() => {
        if (!emitter) return undefined;
        const offs = events.map((e) => emitter.on(e, bump));
        // Whatever changed between the render and subscribing would be missed: re-read once.
        bump();
        return () => offs.forEach((off) => off());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [emitter, key]);
}

/**
 * Connects once and shares the agent with every hook below it.
 * Props: url, token | getToken, deviceId?, webrtc?, getUserMedia? (as connect()),
 * or agent — an already connected CallioAgent. connect: a replacement for the
 * SDK's connect (tests).
 */
export function CallioProvider({ children, agent: given, connect = sdkConnect, ...options }) {
    const [state, setState] = useState(() => ({ agent: given ?? null, status: given ? 'ready' : 'connecting', error: null }));
    const optionsRef = useRef(options);
    optionsRef.current = options;
    // A new token is not a new connection: the latest token / getToken is read
    // on every (re)connect. Only another url or device reconnects.
    const identity = `${options.url}|${options.deviceId ?? ''}`;

    useEffect(() => {
        if (given) { setState({ agent: given, status: 'ready', error: null }); return undefined; }
        let closed = false;
        let agent = null;
        setState({ agent: null, status: 'connecting', error: null });
        const latestToken = () => {
            const o = optionsRef.current;
            return o.getToken ? o.getToken() : o.token;
        };
        connect({ ...optionsRef.current, token: undefined, getToken: latestToken }).then((a) => {
            agent = a;
            if (closed) { a.close(); return; }
            setState({ agent: a, status: 'ready', error: null });
        }, (error) => {
            if (!closed) setState({ agent: null, status: 'error', error });
        });
        return () => { closed = true; agent?.close(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [given, identity]);

    // Connection status after the first connect.
    useEffect(() => {
        const agent = state.agent;
        if (!agent) return undefined;
        const offs = [
            agent.on('disconnected', () => setState((s) => ({ ...s, status: 'reconnecting' }))),
            agent.on('ready', () => setState((s) => ({ ...s, status: 'ready', error: null }))),
        ];
        return () => offs.forEach((off) => off());
    }, [state.agent]);

    return createElement(CallioContext.Provider, { value: state }, children);
}

/** { agent, status: 'connecting' | 'ready' | 'reconnecting' | 'error', error }. */
export function useCallio() {
    const ctx = useContext(CallioContext);
    if (!ctx) throw new Error('useCallio must be used inside <CallioProvider>');
    return ctx;
}

/** This agent: identity, availability, role, and setAvailability. */
export function useAgent() {
    const { agent } = useCallio();
    useEmitter(agent, ['ready', 'availability', 'sessionRefreshed']);
    const setAvailability = useCallback((value, opts) => agent?.setAvailability(value, opts), [agent]);
    return {
        agent,
        me: agent?.agent ?? null,
        tenant: agent?.session?.tenant ?? null,
        availability: agent?.availability ?? null,
        isSupervisor: Boolean(agent?.isSupervisor),
        setAvailability,
    };
}

const CALL_LIST_EVENTS = ['incoming', 'elsewhere', 'callState', 'callEnded', 'ready'];

/** This agent's calls (the SDK's Call objects). */
export function useCalls() {
    const { agent } = useCallio();
    useEmitter(agent, CALL_LIST_EVENTS);
    return agent ? [...agent.calls.values()] : [];
}

/** Calls ringing for this agent. */
export function useIncomingCalls() {
    return useCalls().filter((c) => c.state === 'ringing');
}

/** The call this agent is on (connecting, active or dialing), or null. */
export function useActiveCall() {
    return useCalls().find((c) => ['connecting', 'active', 'dialing'].includes(c.state)) ?? null;
}

const CALL_EVENTS = ['state', 'updated', 'remoteStream', 'ended', 'dtmf', 'customerMedia', 'supervisorMode', 'privateChanged'];

/** One call, kept current: its state, data, streams, and its actions. */
export function useCall(call) {
    useEmitter(call, CALL_EVENTS);
    const [muted, setMuted] = useState(call?.muted ?? false);
    const [lastDigit, setLastDigit] = useState(null);
    useEffect(() => {
        if (!call) return undefined;
        setMuted(call.muted);
        return call.on('dtmf', ({ digit }) => setLastDigit(digit));
    }, [call]);

    // Built on every render: the SDK updates call.data in place.
    return {
        call,
        state: call?.state ?? null,
        data: call?.data ?? null,
        customer: call?.customer ?? null,
        remoteStream: call?.remoteStream ?? null,
        endReason: call?.endReason ?? null,
        muted,
        lastDigit,
        accept: (opts) => call?.accept(opts),
        decline: () => call?.decline(),
        hangup: () => call?.hangup(),
        mute: (value = true) => { call?.mute(value); setMuted(Boolean(value)); },
        transfer: (target) => call?.transfer(target),
        setPrivate: (active) => call?.setPrivate(active),
        switchHere: (opts) => call?.switchHere(opts),
    };
}

/** Queue snapshots. */
export function useQueues() {
    const { agent } = useCallio();
    useEmitter(agent, ['queue', 'ready']);
    return agent ? [...agent.queues.values()] : [];
}

/** The tenant's agents' availability, as reported since connecting. */
export function useTeam() {
    const { agent } = useCallio();
    useEmitter(agent, ['team', 'ready']);
    return agent ? [...agent.team.values()] : [];
}

/** Supervisors: the tenant's live calls. */
export function useBoard() {
    const { agent } = useCallio();
    useEmitter(agent, ['board', 'boardCall', 'boardCallEnded', 'ready']);
    return agent ? [...agent.board.values()] : [];
}

const MONITOR_EVENTS = ['state', 'mode', 'agentStream', 'customerStream', 'ended'];

/**
 * Supervisors: monitoring one call. start() asks for the microphone and
 * listens; setMode('whisper' | 'barge'); stop(). Stops when the component
 * unmounts or callId changes.
 */
export function useMonitor(callId) {
    const { agent } = useCallio();
    const [monitor, setMonitor] = useState(null);
    const [error, setError] = useState(null);
    const current = useRef(null);
    useEmitter(monitor, MONITOR_EVENTS);

    const start = useCallback(async (opts) => {
        if (!agent || callId == null) return null;
        setError(null);
        try {
            const m = await agent.monitor(callId, opts);
            current.current = m;
            setMonitor(m);
            return m;
        } catch (err) {
            setError(err);
            return null;
        }
    }, [agent, callId]);

    // Leaving this call (another callId, or unmount) stops its monitor — only
    // its own: this cleanup can run after a monitor for the next call started.
    useEffect(() => () => {
        const m = current.current;
        if (m && String(m.callId) === String(callId)) m.stop();
    }, [callId]);

    const active = monitor && monitor.state !== 'ended' && String(monitor.callId) === String(callId) ? monitor : null;
    return {
        monitor: active,
        state: active?.state ?? 'idle',
        mode: active?.mode ?? null,
        agentStream: active?.agentStream ?? null,
        customerStream: active?.customerStream ?? null,
        error,
        start,
        stop: () => active?.stop(),
        setMode: (mode) => active?.setMode(mode),
        mute: (value = true) => active?.mute(value),
    };
}

/** Plays a MediaStream (a call's remoteStream, a monitor's agent/customer stream). */
export function RemoteAudio({ stream, muted = false, ...props }) {
    const ref = useRef(null);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (el.srcObject !== stream) el.srcObject = stream ?? null;
        if (stream) el.play?.().catch(() => { /* autoplay policies: a user gesture starts it */ });
    }, [stream]);
    return createElement('audio', { ref, autoPlay: true, playsInline: true, muted, ...props });
}
