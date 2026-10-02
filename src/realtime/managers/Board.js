// src/realtime/managers/Board.js
// The board: a tenant's live calls, its agents' statuses and its queues, for
// the sockets allowed to watch them (docs/agent-protocol.md → Board). Nobody
// gets other people's calls without being subscribed:
//   - a call's own events go to its call room (the agents on or offered it,
//     its monitors) and to the board;
//   - the board goes only to subscribers, in Socket.IO rooms narrowed by line,
//     queue or agent, so a dashboard watching one line of a 100k-user product
//     gets that line's events and nothing else.
// Two tiers: 'board' (calls, agents' statuses, queue snapshots) for supervisors
// and, where the tenant allows a team view (settings.team_view, default true),
// for agents; 'supboard' (offers, transfers, IVR progress, counters) for
// supervisors only. A socket that may see the board is subscribed to the whole
// tenant when it connects, so clients that never subscribe keep today's view;
// board:subscribe narrows it. Rooms are cluster-wide through the Redis adapter.
import { roomManager } from './RoomManager.js';
import CallRepository from '../../persistence/CallRepository.js';
import AgentRepository from '../../persistence/AgentRepository.js';
import ChannelRepository from '../../persistence/ChannelRepository.js';
import QueueRepository from '../../persistence/QueueRepository.js';
import TenantRepository from '../../persistence/TenantRepository.js';
import { redisBaseService } from '../../infra/redis/RedisBaseService.js';
import { AgentRole } from '../../core/constants/CallConstants.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('realtime.Board');

export const Tier = Object.freeze({ TEAM: 'board', SUPERVISOR: 'supboard' });

const COUNTERS_EVERY_MS = 2000;
const MAX_FILTER_IDS = 100;

const room = (tier, tenantId, key = null) => (key ? `${tier}:${tenantId}:${key}` : `${tier}:${tenantId}`);
const countersRoom = (tenantId) => room(Tier.SUPERVISOR, tenantId, 'counters');

export class BoardError extends Error {}

class Board {
    constructor() {
        this._countersDue = new Map();   // tenantId → timer (this worker)
    }

    // The tiers this socket may see.
    async tiers(socket) {
        if (socket.user?.role === AgentRole.SUPERVISOR) return [Tier.TEAM, Tier.SUPERVISOR];
        const { teamView } = await TenantRepository.getBoardSettings(socket.tenant.id);
        return teamView ? [Tier.TEAM] : [];
    }

    // On connect: the whole tenant for a socket that may see the board.
    async subscribeDefault(socket) {
        const tiers = await this.tiers(socket);
        this.#join(socket, tiers, null);
        return tiers;
    }

    /**
     * Narrows (or widens) this socket's board. filter: { channelIds?,
     * agentIds?, queueIds? } — the union of what they match; empty or absent =
     * the whole tenant. Every id must belong to the socket's tenant.
     */
    async subscribe(socket, filter) {
        const tiers = await this.tiers(socket);
        if (!tiers.length) throw new BoardError('The board is not available to this agent');
        const clean = await this.#validFilter(socket.tenant.id, filter);
        this.#join(socket, tiers, clean);
        return clean;
    }

    unsubscribe(socket) {
        for (const r of socket.data.board?.rooms ?? []) socket.leave(r);
        socket.data.board = { tiers: socket.data.board?.tiers ?? [], filter: null, rooms: [] };
    }

    // Whether this socket may see the board at all (queue snapshots, team calls).
    canSee(socket, tier = Tier.TEAM) {
        return Boolean(socket.data.board?.tiers?.includes(tier));
    }

    #join(socket, tiers, filter) {
        for (const r of socket.data.board?.rooms ?? []) socket.leave(r);
        const keys = filter
            ? [
                ...(filter.channelIds ?? []).map((id) => `channel:${id}`),
                ...(filter.queueIds ?? []).map((id) => `queue:${id}`),
                ...(filter.agentIds ?? []).map((id) => `agent:${id}`),
            ]
            : [null];
        const tenantId = socket.tenant.id;
        const rooms = tiers.flatMap((tier) => keys.map((key) => room(tier, tenantId, key)));
        if (tiers.includes(Tier.SUPERVISOR)) rooms.push(countersRoom(tenantId));
        if (rooms.length) socket.join(rooms);
        socket.data.board = { tiers, filter, rooms };
    }

    async #validFilter(tenantId, filter) {
        if (filter == null) return null;
        const ids = (list, name) => {
            if (list == null) return [];
            if (!Array.isArray(list) || list.length > MAX_FILTER_IDS) throw new BoardError(`${name} must be an array of at most ${MAX_FILTER_IDS} ids`);
            const out = [...new Set(list.map(Number))];
            if (out.some((n) => !Number.isInteger(n) || n <= 0)) throw new BoardError(`${name} must hold ids`);
            return out;
        };
        const channelIds = ids(filter.channelIds, 'channelIds');
        const queueIds = ids(filter.queueIds, 'queueIds');
        const agentIds = ids(filter.agentIds, 'agentIds');
        for (const id of channelIds) if (!await ChannelRepository.findForTenant(id, tenantId)) throw new BoardError(`Unknown channel ${id}`);
        for (const id of queueIds) if (!await QueueRepository.findForTenant(id, tenantId)) throw new BoardError(`Unknown queue ${id}`);
        const agents = await AgentRepository.findByIds(agentIds);
        if (agents.length !== agentIds.length || agents.some((a) => String(a.tenant_id) !== String(tenantId))) throw new BoardError('Unknown agent');
        if (!channelIds.length && !queueIds.length && !agentIds.length) return null;
        return { channelIds, queueIds, agentIds };
    }

    // ── Emitting ──────────────────────────────────────────────────────────────

    // The board rooms an event about this scope reaches.
    rooms(tier, tenantId, { channelId = null, queueId = null, agentIds = [] } = {}) {
        const rooms = [room(tier, tenantId)];
        if (channelId) rooms.push(room(tier, tenantId, `channel:${channelId}`));
        if (queueId) rooms.push(room(tier, tenantId, `queue:${queueId}`));
        for (const id of agentIds) if (id) rooms.push(room(tier, tenantId, `agent:${id}`));
        return rooms;
    }

    /**
     * A call's event: to its call room and the board rooms its line, queue and
     * agent belong to (read from the call row). extraAgentIds: agents the event
     * is also about (e.g. the previous agent of a transfer).
     */
    async callEvent(tier, callId, event, data, { callRoom = true, extraAgentIds = [] } = {}) {
        try {
            const call = await CallRepository.findById(callId);
            const tenantId = call?.tenant_id ?? data.tenantId;
            if (!tenantId) return;
            const rooms = this.rooms(tier, tenantId, {
                channelId: call?.channel_id, queueId: call?.queue_id, agentIds: [call?.agent_id, ...extraAgentIds],
            });
            if (callRoom) rooms.push(`call:${callId}`);
            roomManager.emitToRooms(rooms, event, data);
            this.countersChanged(tenantId);
        } catch (err) {
            log.error({ callId, err }, 'Board event failed');
        }
    }

    // An agent's status: their own sockets always, plus the board.
    agentStatus(tenantId, agentId, event, data) {
        roomManager.emitToRooms([`user:${agentId}`, ...this.rooms(Tier.TEAM, tenantId, { agentIds: [agentId] })], event, data);
        this.countersChanged(tenantId);
    }

    queueSnapshot(tenantId, queueId, event, data) {
        roomManager.emitToRooms(this.rooms(Tier.TEAM, tenantId, { queueId }), event, data);
    }

    // ── Counters ──────────────────────────────────────────────────────────────

    // Something on the tenant's board changed: push fresh counters to its
    // supervisors at most every COUNTERS_EVERY_MS, computed by one worker.
    countersChanged(tenantId) {
        if (this._countersDue.has(tenantId)) return;
        const timer = setTimeout(async () => {
            this._countersDue.delete(tenantId);
            try {
                const won = await redisBaseService.getClient().set(`callio:board:counters:${tenantId}`, '1', 'PX', COUNTERS_EVERY_MS - 100, 'NX');
                if (!won) return;
                roomManager.emitToRooms([countersRoom(tenantId)], 'board:counters', await this.counters(tenantId));
            } catch (err) {
                log.warn({ tenantId, err }, 'Board counters failed');
            }
        }, COUNTERS_EVERY_MS);
        timer.unref();
        this._countersDue.set(tenantId, timer);
    }

    async counters(tenantId) {
        const [calls, agents] = await Promise.all([
            CallRepository.countLiveForTenant(tenantId),
            AgentRepository.getTenantAvailabilityStats(tenantId),
        ]);
        return {
            tenantId,
            calls,
            agents: { total: agents.total, available: agents.available, onCall: agents.on_call, offline: agents.offline },
            at: new Date().toISOString(),
        };
    }

    stop() {
        for (const timer of this._countersDue.values()) clearTimeout(timer);
        this._countersDue.clear();
    }
}

export const board = new Board();
