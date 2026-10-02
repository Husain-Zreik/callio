// src/core/media/MediaTopology.js
// Which media a new call runs on (calls.media_topology), decided once when the
// call is created from what it can need — nothing to configure per line
// (docs/direct-lines.md, Part B):
//   ROOM    anything a room is for: a shared line's IVR, queue, hold music and
//           transfers; recording; whisper or barge
//   DIRECT  a personal line's plain 1:1 call — rtpengine bridges the customer
//           and the agent, no FreeSWITCH. A supervisor can still listen (an
//           rtpengine subscription), never be heard.
// A tenant that later turns recording or whisper on gets rooms for its new
// calls; a call in progress keeps its topology.
import TenantRepository from '../../persistence/TenantRepository.js';
import { customerChannels } from '../channels/CustomerChannels.js';
import { MediaTopology } from '../constants/CallConstants.js';
import { config } from '../../../config/envConfig.js';

class MediaTopologyPolicy {
    /**
     * @param channel   the call's channels row
     * @param outbound  an outbound call (the agent offers first)
     */
    async decide(channel, { outbound = false } = {}) {
        if (!config.media.directPath) return MediaTopology.ROOM;
        if (channel?.owner_agent_id == null) return MediaTopology.ROOM;   // shared line
        if (channel.recording_enabled) return MediaTopology.ROOM;
        const modes = await TenantRepository.getMonitoringModes(channel.tenant_id);
        if (modes.some((m) => m !== 'listen')) return MediaTopology.ROOM;  // whisper/barge mix audio
        // Outbound, the agent is answered before the customer: proven for plain
        // RTP carriers; a WebRTC provider (WhatsApp) calls out through a room.
        const transport = customerChannels.has(channel.type) ? customerChannels.get(channel.type).sdp?.transport : null;
        if (outbound && transport !== 'rtp') return MediaTopology.ROOM;
        return MediaTopology.DIRECT;
    }
}

export const mediaTopology = new MediaTopologyPolicy();
