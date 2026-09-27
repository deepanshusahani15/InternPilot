const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');

const { buildCandidateJourney } = require('../utils/candidateJourney');

const now = new Date('2026-09-27T10:00:00.000Z');
const readyProfile = { percentage: 100, requiredMissingCount: 0 };

test('candidate journey sends an incomplete profile to the profile page', () => {
    const journey = buildCandidateJourney({
        profileCompletion: { percentage: 45, requiredMissingCount: 2 },
        now
    });

    assert.equal(journey.currentStage, 'profile');
    assert.equal(journey.action.title, 'Complete your profile');
    assert.equal(journey.action.href, '/candidate/profile');
    assert.equal(journey.stages[0].state, 'current');
});

test('candidate journey prioritizes the earliest active offer and exposes its deadline', () => {
    const journey = buildCandidateJourney({
        profileCompletion: { percentage: 20, requiredMissingCount: 3 },
        offers: [
            { _id: 'later-offer', status: 'issued', isActive: true, expiresAt: '2026-10-02T10:00:00.000Z' },
            { _id: 'urgent-offer', status: 'issued', isActive: true, expiresAt: '2026-09-28T10:00:00.000Z' }
        ],
        now
    });

    assert.equal(journey.currentStage, 'offer');
    assert.equal(journey.action.href, '/candidate/offers/urgent-offer');
    assert.equal(journey.action.badge.label, 'Offer expires in 1 day');
    assert.equal(journey.stages[3].state, 'current');
    assert.equal(journey.stages[0].state, 'complete');
});

test('candidate journey guides verified candidates with no applications to matching internships', () => {
    const journey = buildCandidateJourney({
        profileCompletion: readyProfile,
        verification: { status: 'approved' },
        now
    });

    assert.equal(journey.currentStage, 'applied');
    assert.equal(journey.action.title, 'Explore matching internships');
    assert.equal(journey.action.href, '/internships');
    assert.equal(journey.stages[0].state, 'complete');
});

test('candidate journey highlights an accepted placement with the start date', () => {
    const journey = buildCandidateJourney({
        profileCompletion: readyProfile,
        verification: { status: 'approved' },
        applications: [{ _id: 'hired-application', status: 'Hired' }],
        offers: [{
            _id: 'accepted-offer',
            status: 'accepted',
            terms: { startDate: '2026-10-05T00:00:00.000Z' }
        }],
        now
    });

    assert.equal(journey.currentStage, 'internship');
    assert.equal(journey.action.title, 'Prepare for your internship');
    assert.equal(journey.action.href, '/candidate/applications#app-card-hired-application');
    assert.match(journey.action.badge.label, /^Starts /);
});

test('candidate journey lets a completed candidate view an issued certificate', () => {
    const journey = buildCandidateJourney({
        profileCompletion: readyProfile,
        verification: { status: 'approved' },
        certificates: [{ certificateId: 'IP-2026-0001', status: 'Issued', issuedAt: '2026-09-20T10:00:00.000Z' }],
        now
    });

    assert.equal(journey.currentStage, 'certificate');
    assert.equal(journey.action.title, 'Download your certificate');
    assert.equal(journey.action.href, '/certificates/IP-2026-0001/view');
    assert.equal(journey.stages[5].state, 'current');
});

test('the tracker renders a responsive journey card with the full lifecycle timeline', () => {
    const trackerPath = path.join(__dirname, '..', 'views', 'candidate', 'candidate-tracker.ejs');
    const template = fs.readFileSync(trackerPath, 'utf8').replace("<% layout('layouts/boilerplate') %>", '');
    const journey = buildCandidateJourney({
        profileCompletion: readyProfile,
        verification: { status: 'approved' },
        now
    });

    const html = ejs.render(template, {
        applications: [],
        totalApplications: 0,
        journey
    }, { filename: trackerPath });

    assert.match(html, /data-candidate-journey-card/);
    assert.match(html, /data-journey-timeline-scroll/);
    for (const label of ['Profile', 'Applied', 'Interview', 'Offer', 'Internship', 'Certificate']) {
        assert.match(html, new RegExp(`>\\s*${label}\\s*<`));
    }
    assert.match(html, /href="\/internships"/);
    assert.match(html, /overflow-x-auto/);
});
