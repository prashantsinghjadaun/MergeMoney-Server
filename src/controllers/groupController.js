const groupDao = require("../dao/groupDao");
const userDao = require("../dao/userDao");

const isGroupMemberOrAdmin = (group, email) => {
    if (!group || !email) return false;
    const lower = email.toLowerCase();
    const isAdmin = group.adminEmail && group.adminEmail.toLowerCase() === lower;
    const isMember = Array.isArray(group.membersEmail) && group.membersEmail.some(m => m && m.toLowerCase() === lower);
    return Boolean(isAdmin || isMember);
};

const groupController = {

    create: async (request, response) => {
        try {
            const user = request.user;
            const { name, description, membersEmail, thumbnail } = request.body;

            let allMembers = [user.email];
            if (membersEmail && Array.isArray(membersEmail)) {
                allMembers = [...new Set([...allMembers, ...membersEmail])];
            }

            const newGroup = await groupDao.createGroup({
                name,
                description,
                adminEmail: user.email,
                membersEmail: allMembers,
                thumbnail,
                paymentStatus: {
                    amount: 0,
                    currency: 'INR',
                    date: Date.now(),
                    isPaid: false
                }
            });

            response.status(201).json({
                message: 'Group created successfully',
                groupId: newGroup._id
            });
        } catch (error) {
            console.error(error);
            response.status(500).json({ message: "Internal server error" });
        }
    },

    update: async (request, response) => {
        try {
            const { groupId } = request.body;
            if (!groupId) {
                return response.status(400).json({ message: "Group ID is required" });
            }

            const existingGroup = await groupDao.getGroupById(groupId);
            if (!existingGroup) {
                return response.status(404).json({ message: "Group not found" });
            }

            const userEmail = request.user?.email?.toLowerCase();
            if (!existingGroup.adminEmail || existingGroup.adminEmail.toLowerCase() !== userEmail) {
                return response.status(403).json({ message: "Only the group admin can update group details" });
            }

            const updatedGroup = await groupDao.updateGroup(request.body);
            if (!updatedGroup) {
                return response.status(404).json({ message: "Group not found" });
            }
            response.status(200).json(updatedGroup);
        } catch (error) {
            console.error('[CONTROLLER] Error updating group:', error);
            response.status(500).json({ message: "Error updating group" });
        }
    },

    getGroupById: async (request, response) => {
        try {
            const { groupId } = request.params;
            
            if (!groupId) {
                return response.status(400).json({ message: "Group ID is required" });
            }
            
            const group = await groupDao.getGroupById(groupId);
            
            if (!group) {
                return response.status(404).json({ message: "Group not found" });
            }

            const userEmail = request.user?.email;
            if (!isGroupMemberOrAdmin(group, userEmail)) {
                return response.status(403).json({ message: "Access denied: You are not a member of this group" });
            }
            
            response.status(200).json(group);
        } catch (error) {
            console.error('[CONTROLLER] Error fetching group:', error);
            response.status(500).json({ message: "Error fetching group", error: error.message });
        }
    },

    addMembers: async (request, response) => {
        try {
            const { groupId, emails } = request.body;
            if (!groupId) {
                return response.status(400).json({ message: "Group ID is required" });
            }

            if (!emails || !Array.isArray(emails) || emails.length === 0) {
                return response.status(400).json({ message: "Emails list is required and must be a non-empty array" });
            }

            const group = await groupDao.getGroupById(groupId);
            if (!group) {
                return response.status(404).json({ message: "Group not found" });
            }

            const userEmail = request.user?.email?.toLowerCase();
            if (!group.adminEmail || group.adminEmail.toLowerCase() !== userEmail) {
                return response.status(403).json({ message: "Only the group admin can add members" });
            }

            const existingMembersLower = new Set(
                (group.membersEmail || []).map(e => e.toLowerCase())
            );

            const uniqueNewEmails = [];
            for (const email of emails) {
                if (typeof email === 'string' && email.trim()) {
                    const trimmed = email.trim();
                    if (!existingMembersLower.has(trimmed.toLowerCase())) {
                        uniqueNewEmails.push(trimmed);
                        existingMembersLower.add(trimmed.toLowerCase());
                    }
                }
            }

            if (uniqueNewEmails.length === 0) {
                return response.status(200).json(group);
            }

            const updatedGroup = await groupDao.addMembers(groupId, ...uniqueNewEmails);
            response.status(200).json(updatedGroup);
        } catch (error) {
            console.error('[CONTROLLER] Error adding members:', error);
            response.status(500).json({ message: "Error adding members" });
        }
    },

    removeMembers: async (request, response) => {
        try {
            const { groupId, emails } = request.body;
            if (!groupId) {
                return response.status(400).json({ message: "Group ID is required" });
            }

            if (!emails || !Array.isArray(emails) || emails.length === 0) {
                return response.status(400).json({ message: "Emails list is required and must be a non-empty array" });
            }

            const group = await groupDao.getGroupById(groupId);
            if (!group) {
                return response.status(404).json({ message: "Group not found" });
            }

            const userEmail = request.user?.email?.toLowerCase();
            if (!group.adminEmail || group.adminEmail.toLowerCase() !== userEmail) {
                return response.status(403).json({ message: "Only the group admin can remove members" });
            }

            const adminEmailLower = group.adminEmail.toLowerCase();
            const attemptsToRemoveAdmin = emails.some(
                e => typeof e === 'string' && e.trim().toLowerCase() === adminEmailLower
            );
            if (attemptsToRemoveAdmin) {
                return response.status(400).json({ message: "Group admin cannot be removed from the group" });
            }

            const updatedGroup = await groupDao.removeMembers(groupId, ...emails);
            response.status(200).json(updatedGroup);
        } catch (error) {
            console.error('[CONTROLLER] Error removing members:', error);
            response.status(500).json({ message: "Error removing members" });
        }
    },

    getGroupsByUser: async (request, response) => {
        try {
            const email = request.user.email;

            const page = parseInt(request.query.page) || 1;
            const limit = parseInt(request.query.limit) || 10;
            const skip = (page - 1) * limit;

            const sortBy = request.query.sortBy || 'newest';
            let sortOptions = { createdAt: -1 };

            if (sortBy === 'oldest') {
                sortOptions = { createdAt: 1 };
            }

            const { groups, totalCount } = await groupDao.getGroupsPaginated(email, limit, skip, sortOptions);

            response.status(200).json({
                groups: groups,
                pagination: {
                    totalItems: totalCount,
                    totalPages: Math.ceil(totalCount/limit),
                    currentPage: page,
                    itemsPerPage: limit
                }
            });
        } catch (error) {
            response.status(500).json({ message: "Error fetching groups" });
        }
    },

    getGroupsByPaymentStatus: async (request, response) => {
        try {
            const { isPaid } = request.query;
            const status = isPaid === 'true';
            const groups = await groupDao.getGroupByStatus(status);
            response.status(200).json(groups);
        } catch (error) {
            response.status(500).json({ message: "Error filtering groups" });
        }
    },

    getAudit: async (request, response) => {
        try {
            const { groupId } = request.params;
            const group = await groupDao.getGroupById(groupId);
            if (!group) {
                return response.status(404).json({ message: "Group not found" });
            }

            const userEmail = request.user?.email;
            if (!isGroupMemberOrAdmin(group, userEmail)) {
                return response.status(403).json({ message: "Access denied: You are not a member of this group" });
            }

            const lastSettled = await groupDao.getAuditLog(groupId);
            response.status(200).json({ lastSettled });
        } catch (error) {
            response.status(500).json({ message: "Error fetching audit log" });
        }
    }
};

module.exports = groupController;
