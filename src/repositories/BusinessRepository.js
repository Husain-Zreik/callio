// src/repositories/BusinessRepository.js
import connection from '../../config/dbConnection.js';
import { config } from '../../config/envConfig.js';
import { RoutingStrategy } from '../services/call/constants/CallConstants.js';
import AgentRepository from './AgentRepository.js';
import UserGroupRepository from './UserGroupRepository.js';

class BusinessRepository {
    async getCallRoutingSettings(businessId) {
        const [rows] = await connection.execute(
            `SELECT
                JSON_UNQUOTE(JSON_EXTRACT(call_settings, '$.assignment_strategy')) AS assignment_strategy,
                JSON_UNQUOTE(JSON_EXTRACT(call_settings, '$.receptionist_target_type')) AS receptionist_target_type,
                CAST(JSON_EXTRACT(call_settings, '$.receptionist_target_id') AS UNSIGNED) AS receptionist_target_id,
                CAST(JSON_EXTRACT(call_settings, '$.receptionist_agent_id') AS UNSIGNED) AS receptionist_agent_id,
                JSON_UNQUOTE(JSON_EXTRACT(call_settings, '$.priority_mode')) AS priority_mode,
                CAST(JSON_EXTRACT(call_settings, '$.priority_group_id') AS UNSIGNED) AS priority_group_id,
                JSON_EXTRACT(call_settings, '$.priority_agent_ids') AS priority_agent_ids
             FROM businesses
             WHERE id = ?
             LIMIT 1`,
            [businessId]
        );

        const row = rows[0] || {};
        const assignmentStrategy = String(row.assignment_strategy || RoutingStrategy.QUEUE).toUpperCase();
        const receptionistTargetType = String(row.receptionist_target_type || '').toLowerCase();
        const receptionistTargetIdRaw = Number.isInteger(row.receptionist_target_id)
            ? row.receptionist_target_id
            : (row.receptionist_target_id ? Number(row.receptionist_target_id) : null);
        const receptionistAgentId = Number.isInteger(row.receptionist_agent_id)
            ? row.receptionist_agent_id
            : (row.receptionist_agent_id ? Number(row.receptionist_agent_id) : null);
        const priorityMode = String(row.priority_mode || '').toUpperCase() || null;
        const priorityGroupId = Number.isInteger(row.priority_group_id)
            ? row.priority_group_id
            : (row.priority_group_id ? Number(row.priority_group_id) : null);
        const priorityAgentIds = (() => {
            const raw = row.priority_agent_ids;
            if (!raw) return [];
            try {
                const parsed = Array.isArray(raw) ? raw : JSON.parse(raw);
                if (!Array.isArray(parsed)) return [];
                return parsed
                    .map((id) => Number(id))
                    .filter((id) => Number.isFinite(id))
                    .map((id) => Number(id));
            } catch {
                return [];
            }
        })();
        const receptionistTargetId = Number.isFinite(receptionistTargetIdRaw)
            ? receptionistTargetIdRaw
            : null;

        const normalizedTargetType = (receptionistTargetType === 'agent' || receptionistTargetType === 'group')
            ? receptionistTargetType
            : null;

        const effectiveTargetType = normalizedTargetType || (Number.isFinite(receptionistAgentId) ? 'agent' : null);
        const effectiveTargetId = receptionistTargetId ?? (Number.isFinite(receptionistAgentId) ? receptionistAgentId : null);
        const effectiveReceptionistAgentId = effectiveTargetType === 'agent' ? effectiveTargetId : null;
        const effectiveReceptionistGroupId = effectiveTargetType === 'group' ? effectiveTargetId : null;

        return {
            assignmentStrategy: Object.values(RoutingStrategy).includes(assignmentStrategy)
                ? assignmentStrategy
                : RoutingStrategy.QUEUE,
            receptionistTargetType: effectiveTargetType,
            receptionistTargetId: Number.isFinite(effectiveTargetId) ? effectiveTargetId : null,
            receptionistAgentId: Number.isFinite(effectiveReceptionistAgentId) ? effectiveReceptionistAgentId : null,
            receptionistGroupId: Number.isFinite(effectiveReceptionistGroupId) ? effectiveReceptionistGroupId : null,
            priorityMode: ['AGENT_ORDER', 'GROUP_LEAD_FIRST'].includes(priorityMode) ? priorityMode : 'AGENT_ORDER',
            priorityGroupId: Number.isFinite(priorityGroupId) ? priorityGroupId : null,
            priorityAgentIds,
        };
    }

    // Read the auto-offline-on-missed-calls policy for a business.
    // Returns { enabled, threshold } with safe defaults when absent.
    async getAutoOfflineSettings(businessId) {
        const [rows] = await connection.execute(
            `SELECT
                CAST(JSON_EXTRACT(call_settings, '$.auto_offline_on_missed_calls') AS UNSIGNED) AS enabled_raw,
                CAST(JSON_EXTRACT(call_settings, '$.auto_offline_missed_threshold') AS UNSIGNED) AS threshold_raw
             FROM businesses
             WHERE id = ?
             LIMIT 1`,
            [businessId]
        );

        const row = rows[0] || {};
        const enabled = row.enabled_raw === 1;
        const rawThreshold = Number(row.threshold_raw);
        const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0
            ? Math.min(Math.max(rawThreshold, 1), 20)
            : 3;

        return { enabled, threshold };
    }

    async getBusinessToken(businessId) {
        const [rows] = await connection.execute(
            'SELECT token FROM businesses WHERE id = ?',
            [businessId]
        );
        return rows[0]?.token || null;
    }

    async isCallCentered(businessId) {
        const [rows] = await connection.execute(
            'SELECT has_call_center FROM businesses WHERE id = ?',
            [businessId]
        );
        return rows[0]?.has_call_center || false;
    }

    async getRecordingStorageUsage(businessId) {
        const platformLimitBytes =
            (config.call.recordingStorageLimitGb || 0)
            * 1024 * 1024 * 1024;

        const [rows] = await connection.execute(
            `SELECT
                COALESCE(
                    CAST(JSON_EXTRACT(b.call_settings, '$.recording_storage_limit_bytes') AS UNSIGNED),
                    ?
                ) AS limit_bytes,
                COALESCE(SUM(cr.file_size_bytes), 0) AS used_bytes
             FROM businesses b
             LEFT JOIN call_recordings cr
                   ON cr.business_id = b.id AND cr.status = 'completed'
             WHERE b.id = ?
             GROUP BY b.id, b.call_settings`,
            [platformLimitBytes, businessId]
        );

        const row = rows[0];
        if (!row) return { limitBytes: platformLimitBytes, usedBytes: 0, exceeded: false };

        const limitBytes = parseInt(row.limit_bytes);
        const usedBytes  = parseInt(row.used_bytes);

        return {
            limitBytes,
            usedBytes,
            exceeded: limitBytes > 0 && usedBytes >= limitBytes,
        };
    }

    async getBusinessNumberById(businessNumberId) {
        const [rows] = await connection.execute(
            'SELECT * FROM business_numbers WHERE id = ?',
            [businessNumberId]
        );
        return rows[0] || null;
    }

    async getPhoneNumberId(businessNumberId) {
        const [rows] = await connection.execute(
            'SELECT phone_number_id FROM business_numbers WHERE id = ?',
            [businessNumberId]
        );
        return rows[0]?.phone_number_id || null;
    }

    async findBusinessNumberByPhoneId(phoneNumberId) {
        const [rows] = await connection.execute(
            'SELECT id, business_id, display_name FROM business_numbers WHERE phone_number_id = ?',
            [phoneNumberId]
        );
        return rows[0] || null;
    }

    // Return the id of the best-matching ACTIVE IVR menu for this number,
    // or null if no menu condition is currently satisfied.
    //
    // Evaluation order (per trigger_priority ASC, then updated_at DESC):
    //   1. Number-specific menus (business_number_id = businessNumberId) — checked first.
    //   2. Business-level menus (business_number_id IS NULL) — fallback when no
    //      number-specific menu matched.
    //
    // Within each group, the first menu whose trigger_condition is satisfied wins.
    async getActiveIvrMenuForNumber(businessNumberId, businessId = null, effectiveRouting = null) {
        let resolvedBusinessId = businessId ? Number(businessId) : null;

        if (!resolvedBusinessId) {
            const [numberRows] = await connection.execute(
                `SELECT id, business_id
                 FROM business_numbers
                 WHERE id = ?
                 LIMIT 1`,
                [businessNumberId]
            );
            const businessNumber = numberRows[0];
            if (!businessNumber?.business_id) return null;
            resolvedBusinessId = Number(businessNumber.business_id);
        } else {
            const [ownedRows] = await connection.execute(
                `SELECT id
                 FROM business_numbers
                 WHERE id = ?
                   AND business_id = ?
                 LIMIT 1`,
                [businessNumberId, resolvedBusinessId]
            );
            if (!ownedRows[0]) return null;
        }

        // Fetch both number-specific and business-level menus in one query.
        // Number-specific (scope=0) sort before business-level (scope=1).
        const [menus] = await connection.execute(
            `SELECT id, business_id, trigger_condition,
                    CASE WHEN business_number_id = ? THEN 0 ELSE 1 END AS scope_order
              FROM ivr_menus
              WHERE status = 'ACTIVE'
                AND business_id = ?
                AND (business_number_id = ? OR business_number_id IS NULL)
              ORDER BY scope_order ASC, trigger_priority ASC, updated_at DESC`,
            [businessNumberId, resolvedBusinessId, businessNumberId]
        );

        if (menus.length === 0) return null;

        // Lazily fetch scoped agent stats once (all menus share the same business/routing scope)
        let stats = null;
        const getStats = async () => {
            if (!stats) {
                stats = await this.resolveIvrTriggerAvailabilityStats(
                    resolvedBusinessId,
                    effectiveRouting
                );
            }
            return stats;
        };

        // Two-pass evaluation:
        //
        // Pass 1 — number-specific menus (scope_order = 0), highest priority.
        //   If any number-specific menu's condition is met, return it immediately.
        //   Collect the first number-specific ALWAYS menu as a potential fallback.
        //
        // Pass 2 — business-level menus (scope_order = 1), only reached when NO
        //   number-specific menu fired.  A business-level ALWAYS menu should still
        //   activate even if a number-specific conditional menu existed but its
        //   condition was not met — otherwise the call silently bypasses all IVR.

        let numberSpecificAlwaysFallback = null; // first ALWAYS menu scoped to this number
        let numberScopeHasMenus = false;         // true if any number-specific menu exists

        // ── Pass 1: number-specific ───────────────────────────────────────────
        for (const menu of menus) {
            if (menu.scope_order !== 0) continue; // skip business-level in this pass

            numberScopeHasMenus = true;
            const condition = (menu.trigger_condition ?? 'ALWAYS').toUpperCase();

            if (condition === 'ALWAYS') {
                // ALWAYS at number scope wins immediately — no need to check conditions
                return menu.id;
            }

            const s = await getStats();

            if (condition === 'ALL_AGENTS_BUSY') {
                if (s.total > 0 && s.available === 0 && s.on_call > 0) return menu.id;
            } else if (condition === 'ALL_AGENTS_OFFLINE') {
                if (s.total > 0 && s.available === 0 && s.on_call === 0) return menu.id;
            } else if (condition === 'ALL_AGENTS_UNAVAILABLE') {
                if (s.available === 0) return menu.id;
            }
        }

        // ── Pass 2: business-level ─────────────────────────────────────────────
        // Only evaluated when no number-specific menu fired.
        for (const menu of menus) {
            if (menu.scope_order !== 1) continue; // skip number-specific in this pass

            const condition = (menu.trigger_condition ?? 'ALWAYS').toUpperCase();

            if (condition === 'ALWAYS') return menu.id;

            const s = await getStats();

            if (condition === 'ALL_AGENTS_BUSY') {
                if (s.total > 0 && s.available === 0 && s.on_call > 0) return menu.id;
            } else if (condition === 'ALL_AGENTS_OFFLINE') {
                if (s.total > 0 && s.available === 0 && s.on_call === 0) return menu.id;
            } else if (condition === 'ALL_AGENTS_UNAVAILABLE') {
                if (s.available === 0) return menu.id;
            }
        }

        return null;
    }

    async resolveIvrTriggerAvailabilityStats(businessId, effectiveRouting = null) {
        const strategy = String(effectiveRouting?.assignmentStrategy || RoutingStrategy.QUEUE).toUpperCase();

        if (strategy === RoutingStrategy.RECEPTIONIST) {
            const targetType = String(effectiveRouting?.receptionistTargetType || '').toLowerCase();
            const targetId = Number(effectiveRouting?.receptionistTargetId);

            if (targetType === 'agent' && Number.isFinite(targetId)) {
                return AgentRepository.getAvailabilityStatsForAgentIds([targetId], businessId);
            }

            if (targetType === 'group' && Number.isFinite(targetId)) {
                const groupAgents = await UserGroupRepository.getCallCenterAgentsForGroup(businessId, targetId);
                return AgentRepository.getAvailabilityStatsForAgentIds(
                    groupAgents.map((agent) => agent.id),
                    businessId
                );
            }

            return AgentRepository.getAvailabilityStats(businessId);
        }

        if (strategy === RoutingStrategy.PRIORITY) {
            const mode = String(effectiveRouting?.priorityMode || 'AGENT_ORDER').toUpperCase();

            if (mode === 'GROUP_LEAD_FIRST') {
                const priorityGroupId = Number(effectiveRouting?.priorityGroupId);
                if (Number.isFinite(priorityGroupId)) {
                    const groupAgents = await UserGroupRepository.getCallCenterAgentsForGroup(
                        businessId,
                        priorityGroupId
                    );
                    return AgentRepository.getAvailabilityStatsForAgentIds(
                        groupAgents.map((agent) => agent.id),
                        businessId
                    );
                }
            } else {
                const priorityAgentIds = Array.isArray(effectiveRouting?.priorityAgentIds)
                    ? effectiveRouting.priorityAgentIds
                        .map((id) => Number(id))
                        .filter((id) => Number.isFinite(id))
                    : [];
                if (priorityAgentIds.length) {
                    return AgentRepository.getAvailabilityStatsForAgentIds(priorityAgentIds, businessId);
                }
            }
        }

        // QUEUE default: all call-center agents in the business.
        return AgentRepository.getAvailabilityStats(businessId);
    }

    async isRecordingEnabledForBusiness(businessId) {
        const [rows] = await connection.execute(
            `SELECT CAST(JSON_EXTRACT(call_settings, '$.call_recording_enabled') AS UNSIGNED) AS call_recording_enabled
             FROM business_numbers
             WHERE business_id = ?
               AND JSON_UNQUOTE(JSON_EXTRACT(call_settings, '$.calling_status')) = 'ENABLED'
             LIMIT 1`,
            [businessId]
        );
        return rows[0]?.call_recording_enabled === 1;
    }

    async isRecordingEnabledForBusinessNumber(businessNumberId) {
        const [rows] = await connection.execute(
            `SELECT CAST(JSON_EXTRACT(call_settings, '$.call_recording_enabled') AS UNSIGNED) AS call_recording_enabled
             FROM business_numbers
             WHERE id = ?
             LIMIT 1`,
            [businessNumberId]
        );
        return rows[0]?.call_recording_enabled === 1;
    }
}

export default new BusinessRepository();

