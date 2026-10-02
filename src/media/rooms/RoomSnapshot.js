// src/media/rooms/RoomSnapshot.js
// A room's state outside the worker that runs it: written to Redis
// (callState part 'room', callio:call:<id>:room) after every room operation,
// dropped when the room closes. What a worker taking the call over needs to drive the same media
// (docs/media-architecture.md, "What survives a control worker's death"):
// each leg's FreeSWITCH channel uuid and drachtio dialog id (in-dialog
// re-INVITE / BYE from any connection), its rtpengine key and conference
// member, and the room's rules — supervisor mode, agent-private, hold, the
// reconnect tone, the recording.
import { callState } from '../../infra/cluster/CallState.js';

const legOf = (leg) => leg && {
    kind: leg.kind,
    uuid: leg.ep?.uuid ?? null,
    dialogId: leg.ep?.dialog?.id ?? null,
    rtpKey: leg.rtpKey,
    transport: leg.transport,
    memberId: leg.memberId ?? null,
    answered: Boolean(leg.answered),
    agentId: leg.agentId ?? null,
    listening: Boolean(leg.listening),
};

export function snapshotOf(room) {
    return {
        callId: room.callId,
        name: room.name,
        legSeq: room.legSeq,
        mode: room.mode,
        agentPrivate: room.agentPrivate,
        bridged: room.bridged,
        toneOn: room.toneOn,
        holdOn: room.holdOn,
        customer: legOf(room.customer),
        pendingAgent: legOf(room.pendingAgent),
        agents: [...room.agents.values()].map(legOf),
        supervisors: [...room.supervisors.entries()].map(([supervisorId, leg]) => ({ ...legOf(leg), supervisorId })),
        recording: room.recording
            ? { id: room.recording.id, file: room.recording.file, uuid: room.recording.uuid, tenantId: room.recording.tenantId, startedAt: room.recording.startedAt }
            : null,
        savedAt: Date.now(),
    };
}

// A room with no legs (made on demand by an operation that found nothing to
// do) isn't worth a key.
const hasLegs = (room) => Boolean(room.customer || room.pendingAgent || room.agents.size || room.supervisors.size);

export async function saveRoom(room) {
    if (!hasLegs(room)) return;
    await callState.save(room.callId, 'room', snapshotOf(room));
}

export const loadRoom = (callId) => callState.load(callId, 'room');
export const dropRoom = (callId) => callState.drop(callId, 'room');
