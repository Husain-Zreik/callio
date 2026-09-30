// src/core/tenancy/EntityDeletion.js
// Deleting a consumer's queues, channels, IVR flows and audio assets
// (Management API DELETEs). Call history survives every delete: its foreign
// keys are SET NULL and a call row keeps its own copies (channel address,
// customer, times).
//
// A delete is refused while something live depends on the entity, and the
// refusal says what (`blockedBy`), so the consumer can re-point it first:
//   queue        live calls in it, channels routing into it, queues overflowing
//                into it, IVR flows transferring to it
//   channel      live calls on it (its IVR flows are deleted with it)
//   IVR flow     live calls that are in it or came through it
//   audio asset  queues holding with it, IVR flows playing it
// The live-call check is part of the DELETE itself (guarded, like every state
// change here), so a call arriving at the same moment can't slip past it.
import QueueRepository from '../../persistence/QueueRepository.js';
import ChannelRepository from '../../persistence/ChannelRepository.js';
import IvrRepository from '../../persistence/IvrRepository.js';
import { storageClient } from '../../infra/storage/StorageClient.js';
import { logger } from '../../infra/logging/logger.js';

const log = logger('core.tenancy.EntityDeletion');

const nodesOf = (flow) => (Array.isArray(flow.structure?.nodes) ? flow.structure.nodes : []);

// IVR transfer nodes default to the channel's queue; only an explicit target counts.
const transfersToQueue = (node, queueId) => node?.type === 'ivr_transfer'
    && String(node.data?.targetType ?? 'queue').toLowerCase() !== 'agent'
    && node.data?.targetId != null && String(node.data.targetId) === String(queueId);

// audioFileId, offlineAudioFileId, busyAudioFileId, ...
const playsAudio = (node, assetId) => Object.entries(node?.data ?? {})
    .some(([key, value]) => /audiofileid$/i.test(key) && value != null && String(value) === String(assetId));

async function flowsWhere(tenantId, predicate) {
    return (await IvrRepository.listFlowStructures(tenantId))
        .filter((flow) => nodesOf(flow).some(predicate))
        .map((flow) => flow.external_ref);
}

const refused = (blockedBy) => ({ deleted: false, blockedBy });
const blocking = (b) => Object.values(b).some((list) => list === true || list.length > 0);

class EntityDeletion {
    async deleteQueue(tenantId, queue) {
        const blockedBy = {
            channels: await ChannelRepository.usingInboundQueue(queue.id),
            overflowQueues: await QueueRepository.overflowingInto(queue.id),
            ivrFlows: await flowsWhere(tenantId, (node) => transfersToQueue(node, queue.id)),
        };
        if (blocking(blockedBy)) return refused(blockedBy);
        if (!(await QueueRepository.deleteIfUnused(queue.id, tenantId))) return refused({ liveCalls: true });
        log.info({ tenantId, queueId: queue.id }, 'Queue deleted');
        return { deleted: true };
    }

    async deleteChannel(tenantId, channel) {
        if (!(await ChannelRepository.deleteIfUnused(channel.id, tenantId))) return refused({ liveCalls: true });
        log.info({ tenantId, channelId: channel.id }, 'Channel deleted');
        return { deleted: true };
    }

    async deleteIvrFlow(tenantId, flow) {
        if (!(await IvrRepository.deleteFlowIfUnused(flow.id, tenantId))) return refused({ liveCalls: true });
        log.info({ tenantId, ivrFlowId: flow.id }, 'IVR flow deleted');
        return { deleted: true };
    }

    async deleteAudioAsset(tenantId, asset) {
        const blockedBy = {
            queues: await IvrRepository.queuesHoldingAudio(asset.id),
            ivrFlows: await flowsWhere(tenantId, (node) => playsAudio(node, asset.id)),
        };
        if (blocking(blockedBy)) return refused(blockedBy);
        if (!(await IvrRepository.deleteAudioAsset(asset.id, tenantId))) return { deleted: false, blockedBy: null };
        // A file Callio stored itself (an inline upload) goes with the asset;
        // a registered storage_key is the consumer's own object and stays.
        if (asset.storage_provider === 's3' && String(asset.storage_key).startsWith(`audio/${tenantId}/`) && storageClient.isInitialized) {
            await storageClient.deleteFile(asset.storage_key).catch((err) =>
                log.warn({ tenantId, err }, 'Deleting an uploaded audio file failed — the asset is deleted, the object stays'));
        }
        log.info({ tenantId, audioAssetId: asset.id }, 'Audio asset deleted');
        return { deleted: true };
    }
}

export const entityDeletion = new EntityDeletion();
