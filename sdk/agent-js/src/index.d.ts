// Types for @callio/agent-sdk (docs/agent-protocol.md).

export type Availability = 'AVAILABLE' | 'ON_CALL' | 'OFFLINE';

export interface BoardFilter {
    channelIds?: Array<number | string>;
    queueIds?: Array<number | string>;
    agentIds?: Array<number | string>;
}

export interface BoardCounters {
    tenantId: number;
    calls: { live: number; inIvr: number; waiting: number; ringing: number; inProgress: number };
    agents: { total: number; available: number; onCall: number; offline: number };
    at: string;
}
export type CallStatus = 'INITIATED' | 'RINGING' | 'ACCEPTED' | 'IN_PROGRESS' | 'TERMINATED' | 'FAILED' | 'CANCELLED';
export type CallStateName = 'ringing' | 'dialing' | 'connecting' | 'active' | 'elsewhere' | 'ended';
export type MonitorMode = 'listen' | 'whisper' | 'barge';
export type AgentRole = 'AGENT' | 'SUPERVISOR';

type Listener = (...args: any[]) => void;

/** Minimal event emitter: on() returns an unsubscribe function. */
export class Emitter {
    on(event: string, listener: Listener): () => void;
    once(event: string, listener: Listener): () => void;
    off(event: string, listener: Listener): void;
    emit(event: string, ...args: unknown[]): void;
}

export interface Customer {
    address?: string;
    addressType?: 'E164' | 'WHATSAPP_USER' | 'SIP_URI';
    name?: string | null;
}

/** The call payload shared by call:incoming, call:started and calls:list. */
export interface CallData {
    callId: number | string;
    callUuid?: string;
    tenantId?: number | string;
    channel?: 'WHATSAPP' | 'SIP' | string;
    channelId?: number | string;
    channelAddress?: string;
    queueId?: number | string | null;
    direction?: 'INBOUND' | 'OUTBOUND';
    status?: CallStatus;
    state?: 'IVR' | 'QUEUE' | 'ACTIVE' | 'ON_HOLD' | null;
    customer?: Customer;
    agentId?: number | string | null;
    agentName?: string | null;
    externalRef?: string | null;
    ringingAt?: string | null;
    answeredAt?: string | null;
    endedAt?: string | null;
    offeredAgentIds?: Array<number | string>;
    assignmentType?: 'DIRECT' | 'QUEUED' | 'TRANSFERRED' | 'IVR' | string;
    transferredFrom?: { id: number | string | null; name: string | null; isAssignment: boolean } | null;
    assignedBy?: { id: number | string; name: string } | null;
    deviceId?: string | null;
    [field: string]: unknown;
}

/** A call on a supervisor's board (no SDP). ivr: live IVR position, or null. */
export interface BoardCall extends CallData {
    ivr?: { nodeType: string; nodeId: string } | null;
}

export interface Session {
    protocol: number;
    agent: { id: number | string; ref: string; name: string | null; role: AgentRole | null };
    tenant: { id: number | string; ref: string };
    deviceId: string | null;
    purpose: string;
    iceServers: RTCIceServer[];
    /** When TURN credentials expire (the SDK refreshes before that); null for static ones. */
    iceServersExpireAt: string | null;
    serverTime: string;
}

export interface TeamMember { agentId: number | string; availability: Availability; reason?: string; updatedAt?: string }

export interface QueueSnapshot {
    tenantId: number | string;
    queueId: number | string;
    queueName?: string;
    strategy?: 'RING_ALL' | 'ROUND_ROBIN' | 'PRIORITY';
    [field: string]: unknown;
}

export interface CallError { callId: number | string | null; code: string; message: string }

export interface ConnectOptions {
    /** Callio's base URL. */
    url: string;
    /** A fixed agent JWT — or getToken, called on every (re)connect. */
    token?: string;
    getToken?: () => string | Promise<string>;
    /** Stable id for this device (default: one kept in localStorage). */
    deviceId?: string;
    /** WebRTC outside a browser, e.g. @roamhq/wrtc in Node. */
    webrtc?: { RTCPeerConnection: typeof RTCPeerConnection; MediaStream: typeof MediaStream };
    /** The microphone (default: navigator.mediaDevices.getUserMedia). */
    getUserMedia?: () => Promise<MediaStream>;
    /** socket.io-client's io (default: the bundled one). */
    io?: (url: string, opts: object) => unknown;
}

export interface EndInfo {
    reason: 'hangup' | 'declined' | 'withdrawn' | 'answered_elsewhere' | 'terminated' | 'gone' | 'accept_failed' | 'media_failed' | 'error' | string;
    terminationReason?: string;
    terminatedBy?: 'AGENT' | 'CUSTOMER' | 'PROVIDER' | 'SYSTEM';
    withdrawnReason?: 'declined' | 'taken' | 'timeout' | 'overflow' | string;
    [field: string]: unknown;
}

export class Call extends Emitter {
    readonly id: number | string;
    readonly data: CallData;
    readonly state: CallStateName;
    readonly endReason: string | null;
    readonly muted: boolean;
    readonly localStream: MediaStream | null;
    readonly remoteStream: MediaStream | null;
    readonly direction: 'INBOUND' | 'OUTBOUND' | undefined;
    readonly customer: Customer;
    readonly channel: string | undefined;
    readonly queueId: number | string | null;
    readonly callUuid: string | null;
    /** Offered to every member of a RING_ALL queue at once. */
    readonly isRingAll: boolean;

    accept(opts?: { stream?: MediaStream }): Promise<void>;
    decline(): void;
    hangup(): void;
    mute(muted?: boolean): void;
    transfer(target: { agentId: number | string } | { queueId: number | string }): void;
    /** Talk privately to the monitoring supervisor. */
    setPrivate(active: boolean): void;
    /** Move a call active on another of your devices to this one. */
    switchHere(opts?: { stream?: MediaStream }): Promise<void>;

    on(event: 'state', listener: (state: CallStateName, previous: CallStateName) => void): () => void;
    on(event: 'remoteStream', listener: (stream: MediaStream, track: MediaStreamTrack) => void): () => void;
    on(event: 'ended', listener: (info: EndInfo) => void): () => void;
    on(event: 'updated', listener: (data: CallData) => void): () => void;
    on(event: 'customerMedia', listener: (p: { callId: number | string; state: 'active' | 'drop' }) => void): () => void;
    on(event: 'networkTerminating', listener: (p: { callId: number | string }) => void): () => void;
    on(event: 'dtmf', listener: (p: { callId: number | string; digit: string }) => void): () => void;
    on(event: 'supervisorMode', listener: (p: { callId: number | string; mode: MonitorMode }) => void): () => void;
    on(event: 'privateChanged', listener: (p: { callId: number | string; active: boolean }) => void): () => void;
    on(event: string, listener: Listener): () => void;
}

export class Monitor extends Emitter {
    readonly callId: number | string;
    readonly state: 'connecting' | 'active' | 'ended';
    readonly mode: MonitorMode;
    readonly muted: boolean;
    /** The call as the supervisor hears it: the customer and the agent, mixed. */
    readonly stream: MediaStream | null;

    /** listen: hear the call, heard by nobody · whisper: the agent hears you · barge: both hear you. */
    setMode(mode: MonitorMode): void;
    mute(muted?: boolean): void;
    stop(): void;

    on(event: 'state', listener: (state: Monitor['state'], previous: Monitor['state']) => void): () => void;
    on(event: 'stream', listener: (stream: MediaStream, track: MediaStreamTrack) => void): () => void;
    on(event: 'mode', listener: (mode: MonitorMode) => void): () => void;
    on(event: 'agentPrivate', listener: (p: { callId: number | string; active: boolean }) => void): () => void;
    on(event: 'agentReconnected', listener: (p: { callId: number | string }) => void): () => void;
    on(event: 'ended', listener: (info: { reason: 'stopped' | 'ended' | 'call_ended' | 'disconnected' | 'failed' | 'closed' | string }) => void): () => void;
    on(event: string, listener: Listener): () => void;
}

export class CallioAgent extends Emitter {
    constructor(opts: ConnectOptions);
    readonly url: string;
    readonly deviceId: string;
    readonly ready: Promise<CallioAgent>;
    readonly session: Session | null;
    readonly agent: Session['agent'] | null;
    readonly iceServers: RTCIceServer[];
    readonly availability: Availability | null;
    /** This agent's calls. */
    readonly calls: Map<string, Call>;
    readonly queues: Map<string, QueueSnapshot>;
    /** Availability of the tenant's agents, as they change. */
    readonly team: Map<string, TeamMember>;
    /** Supervisors: the tenant's live calls. */
    readonly board: Map<string, BoardCall>;
    /** Supervisors: calls being monitored. */
    readonly monitors: Map<string, Monitor>;
    readonly isSupervisor: boolean;

    /** Supervisors may set another agent's availability. */
    setAvailability(availability: 'AVAILABLE' | 'OFFLINE', opts?: { agentId?: number | string }): void;
    sync(): void;
    /** Narrow this connection's board (any of the given lines, queues, agents); {} = the whole tenant. */
    subscribeBoard(filter?: BoardFilter): Promise<BoardFilter | null>;
    unsubscribeBoard(): Promise<void>;
    /** A page of the live calls, newest first. */
    boardCalls(query?: BoardFilter & { cursor?: number | string; limit?: number }): Promise<{ calls: CallData[]; nextCursor: number | null }>;
    /** Supervisors: the tenant's counters now. */
    boardCounters(): Promise<BoardCounters>;
    startOutbound(callId: number | string, opts?: { stream?: MediaStream }): Promise<Call>;
    call(callId: number | string): Call | null;
    /** Supervisors: listen to a call. */
    monitor(callId: number | string, opts?: { stream?: MediaStream }): Promise<Monitor>;
    /** Supervisors: move any call to an agent or into a queue. */
    transferCall(callId: number | string, target: { agentId: number | string } | { queueId: number | string }): void;
    refreshSession(): void;
    close(): void;

    on(event: 'ready' | 'sessionRefreshed', listener: (session: Session) => void): () => void;
    on(event: 'counters', listener: (counters: BoardCounters) => void): () => void;
    on(event: 'incoming' | 'elsewhere', listener: (call: Call) => void): () => void;
    on(event: 'callState', listener: (call: Call, state: CallStateName, previous: CallStateName) => void): () => void;
    on(event: 'callEnded', listener: (call: Call, info: EndInfo) => void): () => void;
    on(event: 'availability', listener: (p: { availability: Availability; reason?: string }) => void): () => void;
    on(event: 'team', listener: (member: TeamMember) => void): () => void;
    on(event: 'queue', listener: (snapshot: QueueSnapshot) => void): () => void;
    on(event: 'board', listener: (board: Map<string, BoardCall>) => void): () => void;
    on(event: 'boardCall', listener: (call: BoardCall) => void): () => void;
    on(event: 'boardCallEnded', listener: (call: BoardCall, info: { terminationReason?: string; terminatedBy?: string }) => void): () => void;
    on(event: 'error', listener: (error: CallError | Error) => void): () => void;
    on(event: 'disconnected', listener: (reason: string) => void): () => void;
    on(event: string, listener: Listener): () => void;
}

/** Connects and resolves once Callio has identified the agent (session:ready). */
export function connect(opts: ConnectOptions): Promise<CallioAgent>;
