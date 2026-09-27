const STATUS_FILTERS = new Set(['all', 'active', 'closed', 'draft', 'expired']);
const SORT_OPTIONS = new Set(['newest', 'oldest', 'title', 'most_applications', 'deadline']);

function normalizeDashboardStatus(value) {
    const status = typeof value === 'string' ? value.toLowerCase() : '';
    if (status === 'published') return 'active';
    if (status === 'paused') return 'closed';
    return STATUS_FILTERS.has(status) ? status : 'all';
}

function normalizeDashboardSort(value) {
    const sort = typeof value === 'string' ? value.toLowerCase() : '';
    if (sort === 'applications' || sort === 'applications_desc') return 'most_applications';
    if (sort === 'deadline_soonest' || sort === 'deadline_asc') return 'deadline';
    return SORT_OPTIONS.has(sort) ? sort : 'newest';
}

function companyDashboardStatusQuery(status, now = new Date()) {
    const openDeadline = {
        $or: [
            { applicationDeadline: { $exists: false } },
            { applicationDeadline: null },
            { applicationDeadline: { $gte: now } }
        ]
    };

    switch (normalizeDashboardStatus(status)) {
        case 'active':
            return {
                status: { $in: ['published', null] },
                isPaused: { $ne: true },
                ...openDeadline
            };
        case 'closed':
            return {
                $or: [
                    { status: 'closed' },
                    {
                        $and: [
                            { $or: [{ status: 'paused' }, { isPaused: true }] },
                            { status: { $ne: 'draft' } },
                            openDeadline
                        ]
                    }
                ]
            };
        case 'draft':
            return { status: 'draft' };
        case 'expired':
            return {
                status: { $nin: ['draft', 'closed'] },
                applicationDeadline: { $lt: now }
            };
        default:
            return {};
    }
}

function sortCompanyDashboardInternships(internships, sort, applicationCounts = {}) {
    const currentSort = normalizeDashboardSort(sort);
    const createdAt = internship => internship._id.getTimestamp().getTime();

    return [...internships].sort((left, right) => {
        if (currentSort === 'title') {
            const titleDiff = (left.title || '').localeCompare(right.title || '', undefined, { sensitivity: 'base' });
            if (titleDiff) return titleDiff;
        }
        if (currentSort === 'most_applications') {
            const applicationDiff = (applicationCounts[right._id.toString()] || 0)
                - (applicationCounts[left._id.toString()] || 0);
            if (applicationDiff) return applicationDiff;
        }
        if (currentSort === 'deadline') {
            const leftDeadline = left.applicationDeadline ? new Date(left.applicationDeadline).getTime() : Infinity;
            const rightDeadline = right.applicationDeadline ? new Date(right.applicationDeadline).getTime() : Infinity;
            if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;
        }

        const createdAtDiff = currentSort === 'oldest'
            ? createdAt(left) - createdAt(right)
            : createdAt(right) - createdAt(left);
        if (createdAtDiff) return createdAtDiff;
        return currentSort === 'oldest'
            ? left._id.toString().localeCompare(right._id.toString())
            : right._id.toString().localeCompare(left._id.toString());
    });
}

module.exports = {
    companyDashboardStatusQuery,
    normalizeDashboardSort,
    normalizeDashboardStatus,
    sortCompanyDashboardInternships
};
