// src/repositories/UserGroupRepository.js
import connection from '../../config/dbConnection.js';
import { AgentAvailability } from '../services/call/constants/CallConstants.js';

class UserGroupRepository {
    async findByIdForBusiness(groupId, businessId) {
        const [rows] = await connection.execute(
            `SELECT id, business_id, name, description, color
             FROM user_groups
             WHERE id = ?
               AND business_id = ?
             LIMIT 1`,
            [groupId, businessId]
        );
        return rows[0] || null;
    }

    async getCallCenterAgentsForGroup(businessId, groupId) {
        const [rows] = await connection.execute(
            `SELECT DISTINCT u.id, u.name, u.email, u.call_availability, ugm.role AS group_role
             FROM user_group_members ugm
             JOIN user_groups ug
               ON ug.id = ugm.group_id
             JOIN users u
               ON u.id = ugm.user_id
              AND u.business_id = ug.business_id
             JOIN model_has_roles mhr
               ON mhr.model_id = u.id
              AND mhr.model_type = 'App\\\\Models\\\\User'
              AND mhr.business_id = ug.business_id
             JOIN role_has_permissions rhp
               ON rhp.role_id = mhr.role_id
             JOIN permissions p
               ON p.id = rhp.permission_id
             WHERE ug.id = ?
                AND ug.business_id = ?
                AND u.deleted_at IS NULL
                AND p.name = 'call_center_agent_access'
              ORDER BY u.id ASC`,
            [groupId, businessId]
        );

        return rows;
    }

    async getAvailableCallCenterAgentsForGroup(businessId, groupId) {
        const agents = await this.getCallCenterAgentsForGroup(businessId, groupId);
        return agents.filter((agent) => agent.call_availability === AgentAvailability.AVAILABLE);
    }
}

export default new UserGroupRepository();
