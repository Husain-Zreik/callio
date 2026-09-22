// services/call/ivr/IvrEngine.js
//
// State machine for a single IVR call session.
// One instance per call; created and destroyed by IvrCoordinator.
//
// Responsibilities:
//   - Navigate between nodes in the flow graph
//   - Play audio prompts via IvrAudioPlayer
//   - Listen for DTMF digits (from EventBus 'call:dtmf')
//   - Fire timeout when caller does not press a digit in time
//   - Emit 'call:ivr_node'    when a new node is entered
//   - Emit 'call:ivr_complete' when a terminal node is reached
import EventBus from '../../core/EventBus.js';
import { IvrAudioPlayer } from './IvrAudioPlayer.js';
import { ivrErrorAudioProvider } from './IvrErrorAudioProvider.js';

class IvrEngine {
    constructor({
        callId,
        businessId,
        structure,
        defaultTimeout,
        audioSource,
        audioPathMap,
        sessionId,
        recordInput,
        onNodeEntered,
        onDtmfReceived,
        onRouteSelected,
    }) {
        this._callId         = callId;
        this._businessId     = businessId ?? null;
        this._nodes          = this._indexNodes(structure.nodes ?? []);
        this._edges          = structure.edges ?? [];
        this._defaultTimeout = (defaultTimeout ?? 10) * 1000;
        this._audioSource    = audioSource;
        this._audioPathMap   = audioPathMap ?? new Map();
        this._sessionId      = sessionId;
        this._recordInput    = recordInput ?? (() => Promise.resolve());
        this._onNodeEntered  = onNodeEntered ?? (() => {});
        this._onDtmfReceived = onDtmfReceived ?? (() => {});
        this._onRouteSelected = onRouteSelected ?? (() => {});

        this._currentNodeId   = null;
        this._currentMenuNode = null;
        this._player          = null;
        this._timer           = null;
        this._stopped         = false;
        this._replayCount     = 0;

        // Single persistent DTMF handler — registered once in start(), never re-created.
        // Delegates through _currentMenuNode so there is no gap between node transitions
        // where a digit could arrive and be silently dropped.
        this._dtmfHandler = ({ callId, digit }) => {
            if (callId !== this._callId) return;
            if (!this._currentMenuNode || this._stopped) {
                console.warn(`[IvrEngine:${this._callId}] DTMF digit '${digit}' dropped — no active menu node (stopped=${this._stopped})`);
                return;
            }
            this._onDtmf(this._currentMenuNode, digit);
        };
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    start() {
        const startNode = this._findNodeByType('ivr_start');
        if (!startNode) {
            console.error(`[IvrEngine:${this._callId}] No ivr_start node found — aborting`);
            this._complete('error');
            return;
        }

        const firstEdge = this._edges.find(e => e.source === startNode.id);
        if (!firstEdge) {
            console.error(`[IvrEngine:${this._callId}] ivr_start (${startNode.id}) has no outgoing edge — aborting`);
            this._complete('error');
            return;
        }

        EventBus.on('call:dtmf', this._dtmfHandler);
        this._navigateTo(firstEdge.target);
    }

    stop() {
        if (this._stopped) return;
        this._stopped = true;
        this._clearPlayer();
        this._clearTimer();
        this._removeDtmfListener();
        console.log(`[IvrEngine:${this._callId}] Stopped`);
    }

    // ── Navigation ────────────────────────────────────────────────────────────

    _navigateTo(nodeId) {
        if (this._stopped) return;

        const node = this._nodes.get(nodeId);
        if (!node) {
            console.error(`[IvrEngine:${this._callId}] Node ${nodeId} not found — hanging up`);
            this._complete('error');
            return;
        }

        this._clearPlayer();
        this._clearTimer();
        this._currentMenuNode = null;

        if (nodeId !== this._currentNodeId) this._replayCount = 0;
        this._currentNodeId = nodeId;

        console.log(`[IvrEngine:${this._callId}] → ${node.type} (${nodeId})`);

        EventBus.emit('call:ivr_node', {
            callId:     this._callId,
            businessId: this._businessId,
            nodeId,
            nodeType:   node.type,
        });
        this._safeNotify(this._onNodeEntered, {
            nodeId,
            nodeType: node.type,
            nodeLabel: node.data?.label ?? null,
        });

        switch (node.type) {
            case 'ivr_menu':     this._enterMenu(node);                          break;
            case 'ivr_play':     this._enterPlay(node);                          break;
            case 'ivr_transfer': this._complete('transferred', node.data ?? {}); break;
            case 'ivr_hangup':   this._complete('hung_up');                      break;
            default:
                console.warn(`[IvrEngine:${this._callId}] Unknown node type: ${node.type}`);
                this._complete('error');
        }
    }

    _enterMenu(node) {
        const { data = {} } = node;
        const audioPath = this._audioPathMap.get(node.id);
        const timeoutMs = ((data.timeoutSeconds ?? 0) * 1000) || this._defaultTimeout;

        if (!audioPath) {
            console.warn(`[IvrEngine:${this._callId}] No audio for menu node ${node.id} — playing error and hanging up`);
            this._playErrorAndHangup();
            return;
        }

        this._currentMenuNode = node;
        this._player = new IvrAudioPlayer(this._audioSource);
        const capturedPlayer = this._player;

        this._player.play(audioPath).then(() => {
            if (this._stopped) return;
            if (this._player !== capturedPlayer) return;
            this._player = null;
            this._timer = setTimeout(() => this._onMenuTimeout(node), timeoutMs);
        }).catch((err) => {
            console.error(`[IvrEngine:${this._callId}] Audio playback error for node=${node.id}: ${err?.message}`);
            if (!this._stopped) this._playErrorAndHangup();
        });
    }

    _enterPlay(node) {
        const audioPath = this._audioPathMap.get(node.id);
        if (!audioPath) {
            console.warn(`[IvrEngine:${this._callId}] No audio for play node ${node.id} — playing error and hanging up`);
            this._playErrorAndHangup();
            return;
        }

        this._player = new IvrAudioPlayer(this._audioSource);

        this._player.play(audioPath).then(() => {
            if (this._stopped) return;
            const nextEdge = this._edges.find(e => e.source === node.id);
            if (nextEdge) {
                this._navigateTo(nextEdge.target);
            } else {
                console.warn(`[IvrEngine:${this._callId}] ivr_play ${node.id} has no outgoing edge`);
                this._complete('hung_up');
            }
        }).catch((err) => {
            console.error(`[IvrEngine:${this._callId}] _enterPlay error for node=${node.id}:`, err?.message);
            if (!this._stopped) this._playErrorAndHangup();
        });
    }

    // ── DTMF / Timeout ────────────────────────────────────────────────────────

    _onDtmf(node, digit) {
        if (this._stopped) return;
        this._safeNotify(this._onDtmfReceived, {
            digit,
            nodeId: node.id,
            nodeType: node.type,
            nodeLabel: node.data?.label ?? null,
        });

        const digitStr = String(digit);
        const edge = this._edges.find(
            e => e.source === node.id && String(e.sourceHandle) === digitStr
        );
        let targetNodeId = edge?.target ?? null;
        let routeMethod = edge ? 'edge' : null;

        if (!targetNodeId && node.data?.dtmfMap) {
            const legacyTargetId = node.data.dtmfMap[digitStr] ?? node.data.dtmfMap[digit];
            if (legacyTargetId) {
                const legacyNode = this._nodes.get(legacyTargetId);
                if (legacyNode) {
                    targetNodeId = legacyTargetId;
                    routeMethod = 'legacy_map';
                }
            }
        }

        if (!targetNodeId) {
            const allHandles = this._edges
                .filter(e => e.source === node.id)
                .map(e => `'${e.sourceHandle}'`);
            console.warn(
                `[IvrEngine:${this._callId}] Digit '${digitStr}' has no route on node=${node.id} — ignoring. ` +
                `Available: [${allHandles.join(', ') || 'none'}]`
            );
            this._safeNotify(this._onRouteSelected, {
                digit,
                routeMethod: 'none',
                status: 'invalid',
                sourceNodeId: node.id,
                sourceNodeType: node.type,
                sourceNodeLabel: node.data?.label ?? null,
                targetNodeId: null,
                targetNodeType: null,
                targetNodeLabel: null,
            });
            return;
        }

        console.log(`[IvrEngine:${this._callId}] Digit '${digit}' → node=${targetNodeId} (${routeMethod})`);
        const targetNode = this._nodes.get(targetNodeId);
        this._safeNotify(this._onRouteSelected, {
            digit,
            routeMethod,
            status: 'matched',
            sourceNodeId: node.id,
            sourceNodeType: node.type,
            sourceNodeLabel: node.data?.label ?? null,
            targetNodeId,
            targetNodeType: targetNode?.type ?? null,
            targetNodeLabel: targetNode?.data?.label ?? null,
        });

        this._recordInput({
            sessionId: this._sessionId,
            digit,
            nodeId: node.id,
        }).catch(() => {/* non-fatal */});

        this._navigateTo(targetNodeId);
    }

    _onMenuTimeout(node) {
        if (this._stopped) return;

        const GRACE_MS = 300;
        const action = node.data?.noInputAction ?? 'replay';
        console.warn(`[IvrEngine:${this._callId}] No input timeout on node=${node.id}, action=${action}`);

        this._timer = setTimeout(() => {
            this._timer = null;
            this._executeTimeout(node);
        }, GRACE_MS);
    }

    _executeTimeout(node) {
        if (this._stopped) return;

        const action = node.data?.noInputAction ?? 'replay';

        if (action === 'replay') {
            this._replayCount++;
            if (this._replayCount > 3) {
                console.warn(`[IvrEngine:${this._callId}] Max replays reached on node ${node.id} — hanging up`);
                this._complete('hung_up');
                return;
            }
            this._navigateTo(node.id);
        } else {
            this._replayCount = 0;
            const hangupNode = [...this._nodes.values()].find(n => n.type === 'ivr_hangup');
            if (hangupNode) {
                this._navigateTo(hangupNode.id);
            } else {
                this._complete('timeout');
            }
        }
    }

    // ── Terminal ──────────────────────────────────────────────────────────────

    _complete(action, transferData = {}) {
        if (this._stopped) return;
        this._stopped = true;
        this._clearPlayer();
        this._clearTimer();
        this._removeDtmfListener();

        console.log(`[IvrEngine:${this._callId}] Complete — action=${action}`);
        EventBus.emit('call:ivr_complete', { callId: this._callId, action, transferData });
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _playErrorAndHangup() {
        this._clearPlayer();
        this._clearTimer();
        this._removeDtmfListener();

        const errorPath = ivrErrorAudioProvider.getPath();

        if (!errorPath) {
            console.warn(`[IvrEngine:${this._callId}] No error audio configured — hanging up immediately`);
            this._complete('hung_up');
            return;
        }

        const player = new IvrAudioPlayer(this._audioSource);
        player.play(errorPath)
            .catch(() => {})
            .finally(() => {
                if (!this._stopped) this._complete('hung_up');
            });
    }

    _clearPlayer() {
        if (this._player) {
            this._player.stop();
            this._player = null;
        }
    }

    _clearTimer() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }

    _removeDtmfListener() {
        if (this._dtmfHandler) {
            EventBus.off('call:dtmf', this._dtmfHandler);
            this._dtmfHandler = null;
        }
    }

    _indexNodes(nodes) {
        const map = new Map();
        for (const n of nodes) map.set(n.id, n);
        return map;
    }

    _findNodeByType(type) {
        for (const n of this._nodes.values()) {
            if (n.type === type) return n;
        }
        return null;
    }

    _safeNotify(handler, payload) {
        try {
            handler(payload);
        } catch (err) {
            console.warn(`[IvrEngine:${this._callId}] Observer callback failed:`, err?.message ?? err);
        }
    }
}

export { IvrEngine };
