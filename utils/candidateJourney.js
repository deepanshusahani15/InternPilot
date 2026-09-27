const JOURNEY_STAGES = [
    { id: 'profile', label: 'Profile', icon: 'ph-user-circle' },
    { id: 'applied', label: 'Applied', icon: 'ph-paper-plane-tilt' },
    { id: 'interview', label: 'Interview', icon: 'ph-chats-circle' },
    { id: 'offer', label: 'Offer', icon: 'ph-handshake' },
    { id: 'internship', label: 'Internship', icon: 'ph-briefcase' },
    { id: 'certificate', label: 'Certificate', icon: 'ph-certificate' }
];

function asDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function idOf(value) {
    if (!value) return '';
    if (typeof value === 'object' && value._id) return idOf(value._id);
    return String(value);
}

function statusOf(value) {
    return String(value || '').trim().toLowerCase();
}

function formatDate(value) {
    const date = asDate(value);
    if (!date) return '';
    return new Intl.DateTimeFormat('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Kolkata'
    }).format(date);
}

function offerDeadlineBadge(expiresAt, now) {
    const deadline = asDate(expiresAt);
    if (!deadline) return null;

    const daysLeft = Math.ceil((deadline.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
    if (daysLeft <= 1) {
        return {
            label: daysLeft <= 0 ? 'Offer expires today' : 'Offer expires in 1 day',
            tone: 'critical',
            icon: 'ph-warning'
        };
    }

    if (daysLeft <= 3) {
        return {
            label: `Offer expires in ${daysLeft} days`,
            tone: 'warning',
            icon: 'ph-hourglass-medium'
        };
    }

    return {
        label: `Respond by ${formatDate(deadline)}`,
        tone: 'info',
        icon: 'ph-calendar-check'
    };
}

function isPendingOffer(offer, now) {
    const deadline = asDate(offer && offer.expiresAt);
    return Boolean(
        offer
        && offer.isActive !== false
        && ['issued', 'accepting'].includes(statusOf(offer.status))
        && deadline
        && deadline.getTime() > now.getTime()
    );
}

function createStages(currentStage) {
    const currentIndex = JOURNEY_STAGES.findIndex(stage => stage.id === currentStage);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;

    return JOURNEY_STAGES.map((stage, index) => ({
        ...stage,
        state: index < safeIndex ? 'complete' : (index === safeIndex ? 'current' : 'upcoming')
    }));
}

function applicationAnchor(application) {
    const applicationId = idOf(application && application._id);
    return applicationId ? `/candidate/applications#app-card-${applicationId}` : '/candidate/applications';
}

/**
 * Produces presentation-safe journey data for the candidate application tracker.
 * The helper intentionally depends only on records that exist in the main app,
 * so it can keep guiding candidates while richer placement-progress data evolves.
 */
function buildCandidateJourney({
    profileCompletion = {},
    verification = null,
    applications = [],
    offers = [],
    certificates = [],
    now = new Date()
} = {}) {
    const currentTime = asDate(now) || new Date();
    const safeApplications = Array.isArray(applications) ? applications : [];
    const safeOffers = Array.isArray(offers) ? offers : [];
    const safeCertificates = Array.isArray(certificates) ? certificates : [];
    const profileNeedsAttention = Number(profileCompletion.requiredMissingCount || 0) > 0;
    const verificationStatus = statusOf(verification && verification.status) || 'not_started';
    const pendingOffers = safeOffers
        .filter(offer => isPendingOffer(offer, currentTime))
        .sort((a, b) => asDate(a.expiresAt).getTime() - asDate(b.expiresAt).getTime());
    const pendingOffer = pendingOffers[0] || null;
    const scheduledInterview = safeApplications.find(application => (
        statusOf(application.status) === 'interview'
        && statusOf(application.interview && application.interview.status) !== 'cancelled'
    ));
    const hiredApplication = safeApplications.find(application => (
        ['hired', 'accepted'].includes(statusOf(application.status))
    ));
    const acceptedOffer = safeOffers.find(offer => statusOf(offer.status) === 'accepted');
    const latestCertificate = safeCertificates
        .filter(certificate => statusOf(certificate.status || 'issued') === 'issued')
        .sort((a, b) => {
            const first = asDate(a.issuedAt)?.getTime() || 0;
            const second = asDate(b.issuedAt)?.getTime() || 0;
            return second - first;
        })[0] || null;

    let currentStage = 'applied';
    let action;

    // An unexpired offer is time-sensitive and takes precedence over less urgent work.
    if (pendingOffer) {
        currentStage = 'offer';
        action = {
            eyebrow: 'Time-sensitive offer',
            title: 'Respond to your offer',
            description: 'Review the terms and accept or decline before the response window closes.',
            ctaLabel: 'Review offer',
            href: `/candidate/offers/${idOf(pendingOffer._id)}`,
            icon: 'ph-handshake',
            badge: offerDeadlineBadge(pendingOffer.expiresAt, currentTime)
        };
    } else if (profileNeedsAttention) {
        currentStage = 'profile';
        const missingCount = Number(profileCompletion.requiredMissingCount || 0);
        action = {
            eyebrow: 'Profile setup',
            title: 'Complete your profile',
            description: `${missingCount} essential profile item${missingCount === 1 ? '' : 's'} still need${missingCount === 1 ? 's' : ''} your attention before you apply.`,
            ctaLabel: 'Complete profile',
            href: '/candidate/profile',
            icon: 'ph-user-circle',
            badge: { label: `${Number(profileCompletion.percentage || 0)}% complete`, tone: 'info', icon: 'ph-chart-line-up' }
        };
    } else if (verificationStatus !== 'approved') {
        currentStage = 'profile';
        const requiresUpdate = ['rejected', 'suspended'].includes(verificationStatus);
        action = {
            eyebrow: 'PMIS verification',
            title: requiresUpdate ? 'Update your verification' : (verificationStatus === 'pending' ? 'Verification under review' : 'Verify your profile'),
            description: requiresUpdate
                ? 'Review the verification feedback and submit the required documents again.'
                : (verificationStatus === 'pending'
                    ? 'Your documents have been submitted. You can check the current review status here.'
                    : 'Submit your required documents to unlock eligible internships.'),
            ctaLabel: requiresUpdate ? 'Update verification' : 'View verification',
            href: '/candidate/verification',
            icon: 'ph-shield-check',
            badge: {
                label: requiresUpdate ? 'Action required' : (verificationStatus === 'pending' ? 'Under review' : 'Not started'),
                tone: requiresUpdate ? 'critical' : 'info',
                icon: requiresUpdate ? 'ph-warning-circle' : 'ph-clock'
            }
        };
    } else if (hiredApplication || acceptedOffer) {
        currentStage = 'internship';
        const startDate = asDate((acceptedOffer && acceptedOffer.terms && acceptedOffer.terms.startDate));
        const hasStarted = startDate && startDate.getTime() <= currentTime.getTime();
        const application = hiredApplication || null;
        action = {
            eyebrow: hasStarted ? 'Internship in progress' : 'Internship placement',
            title: hasStarted ? 'Track your internship' : 'Prepare for your internship',
            description: startDate
                ? (hasStarted ? `Your internship started on ${formatDate(startDate)}. Keep your application details handy.` : `Your internship is scheduled to start on ${formatDate(startDate)}.`)
                : 'Your offer has been accepted. Review the placement details in your application.',
            ctaLabel: hasStarted ? 'View application' : 'Review placement',
            href: application ? applicationAnchor(application) : `/candidate/offers/${idOf(acceptedOffer && acceptedOffer._id)}`,
            icon: 'ph-briefcase',
            badge: startDate
                ? { label: `${hasStarted ? 'Started' : 'Starts'} ${formatDate(startDate)}`, tone: hasStarted ? 'success' : 'info', icon: 'ph-calendar-check' }
                : { label: 'Offer accepted', tone: 'success', icon: 'ph-check-circle' }
        };
    } else if (scheduledInterview) {
        currentStage = 'interview';
        const interviewDate = asDate(scheduledInterview.interview && scheduledInterview.interview.scheduledAt);
        action = {
            eyebrow: 'Interview stage',
            title: 'Review your interview details',
            description: interviewDate
                ? `Your interview is scheduled for ${formatDate(interviewDate)}.`
                : 'Your application is in the interview stage. Check the latest details from the recruiter.',
            ctaLabel: 'View interview',
            href: applicationAnchor(scheduledInterview),
            icon: 'ph-chats-circle',
            badge: interviewDate
                ? { label: formatDate(interviewDate), tone: 'info', icon: 'ph-calendar' }
                : { label: 'Interview active', tone: 'info', icon: 'ph-chats-circle' }
        };
    } else if (latestCertificate) {
        currentStage = 'certificate';
        action = {
            eyebrow: 'Internship completed',
            title: 'Download your certificate',
            description: 'Your official completion certificate is ready to view, download, or share.',
            ctaLabel: 'View certificate',
            href: `/certificates/${encodeURIComponent(String(latestCertificate.certificateId || ''))}/view`,
            icon: 'ph-certificate',
            badge: latestCertificate.issuedAt
                ? { label: `Issued ${formatDate(latestCertificate.issuedAt)}`, tone: 'success', icon: 'ph-seal-check' }
                : { label: 'Certificate ready', tone: 'success', icon: 'ph-seal-check' }
        };
    } else if (safeApplications.length > 0) {
        currentStage = 'applied';
        action = {
            eyebrow: 'Application progress',
            title: 'Track your applications',
            description: 'Review the latest status and next steps for the internships you applied to.',
            ctaLabel: 'View applications',
            href: '/candidate/applications',
            icon: 'ph-list-checks',
            badge: { label: `${safeApplications.length} application${safeApplications.length === 1 ? '' : 's'}`, tone: 'info', icon: 'ph-paper-plane-tilt' }
        };
    } else {
        currentStage = 'applied';
        action = {
            eyebrow: 'Find your next opportunity',
            title: 'Explore matching internships',
            description: 'Browse open internships and apply to start your journey.',
            ctaLabel: 'Explore internships',
            href: '/internships',
            icon: 'ph-magnifying-glass',
            badge: { label: 'No active applications', tone: 'neutral', icon: 'ph-compass' }
        };
    }

    return {
        currentStage,
        stages: createStages(currentStage),
        action
    };
}

module.exports = {
    JOURNEY_STAGES,
    buildCandidateJourney,
    offerDeadlineBadge
};
