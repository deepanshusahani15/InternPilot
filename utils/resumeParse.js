const ResumeParse = require('../models/ResumeParse');
const { formatLocalizedDateTime, formatRelativeTime } = require('./dateFormat');

// Less text than this usually means the file didn't read cleanly (scanned
// pages, image-only PDFs, odd encodings), so the results may be incomplete.
const LOW_TEXT_LENGTH = 300;

const norm = value => String(value || '').trim().toLowerCase();

/**
 * Turns what the parser matched into the record shown on the profile page.
 *
 * Statuses:
 *   unreadable     no text could be read from the file
 *   nothing_found  text was read but no skill or degree matched
 *   low_confidence little text, or only one thing matched
 *   ok             everything else
 *
 * @param {object} input
 * @param {string} input.text Text extracted from the file.
 * @param {string[]} input.skills Skills the parser matched.
 * @param {string} input.qualification Degree the parser matched, or ''.
 * @param {string[]} input.previousSkills The profile's skills before this upload.
 * @param {string} input.previousQualification The profile's degree before this upload.
 * @returns {object}
 */
function summarizeResumeParse({ text, skills, qualification, previousSkills, previousQualification } = {}) {
    const textLength = String(text || '').trim().length;

    // Same skill in different casing counts once; the first spelling wins.
    const found = [];
    const seen = new Set();
    for (const skill of skills || []) {
        const key = norm(skill);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        found.push(String(skill).trim());
    }

    const had = new Set((previousSkills || []).map(norm));
    const newSkills = found.filter(skill => !had.has(norm(skill)));
    const degree = String(qualification || '').trim();
    const matches = found.length + (degree ? 1 : 0);

    let status = 'ok';
    if (!textLength) status = 'unreadable';
    else if (!matches) status = 'nothing_found';
    else if (textLength < LOW_TEXT_LENGTH || matches < 2) status = 'low_confidence';

    return {
        status,
        textLength,
        skills: found,
        newSkills,
        qualification: degree,
        previousQualification: String(previousQualification || '').trim()
    };
}

/**
 * The flash message for uploads where nothing reached the profile. The upload
 * itself still succeeded, so the usual success message stays; this explains
 * why the profile didn't change. Low-confidence results only get the note on
 * the profile card, since something was still added.
 *
 * @param {object} summary From summarizeResumeParse.
 * @returns {string|null}
 */
function parseNotice(summary) {
    if (!summary) return null;
    if (summary.status === 'unreadable') {
        return "Your resume was saved, but we couldn't read any text from it (scanned PDFs and photos can't be read), so nothing was added to your profile.";
    }
    if (summary.status === 'nothing_found') {
        return "Your resume was saved, but we didn't recognise any skills or a degree in it, so nothing was added to your profile.";
    }
    return null;
}

/**
 * Saves what the parser found for the signed-in candidate. Called from the
 * upload route right after parsing. Never throws: a failure here must not
 * break the upload.
 *
 * @param {object} req Needs req.user; uses req.flash when present.
 * @param {object} details { resumeUrl, fileName, text, skills, qualification }
 * @returns {Promise<object|null>} The saved summary, or null.
 */
async function recordResumeParse(req, { resumeUrl, fileName, text, skills, qualification } = {}) {
    const user = req && req.user;
    if (!user || !user._id) return null;

    try {
        const summary = summarizeResumeParse({
            text,
            skills,
            qualification,
            previousSkills: user.skills,
            previousQualification: (user.education && user.education.qualification) || user.qualification
        });
        const record = { ...summary, resumeUrl: resumeUrl || '', fileName: fileName || '', parsedAt: new Date() };

        await ResumeParse.updateOne({ user: user._id }, { $set: record }, { upsert: true, runValidators: true });

        const notice = parseNotice(summary);
        if (notice && req.flash) req.flash('error_msg', notice);
        return record;
    } catch (err) {
        console.error('Could not save resume parse details:', err);
        return null;
    }
}

/**
 * Middleware for the candidate profile page: puts the latest parse on
 * res.locals.resumeParse with ready-to-show dates. Never blocks the page.
 */
async function loadResumeParse(req, res, next) {
    try {
        if (req.user && req.user.role === 'candidate') {
            const parse = await ResumeParse.findOne({ user: req.user._id }).lean();
            if (parse) {
                res.locals.resumeParse = {
                    ...parse,
                    parsedAtLabel: formatLocalizedDateTime(parse.parsedAt),
                    parsedAgo: formatRelativeTime(parse.parsedAt)
                };
            }
        }
    } catch (err) {
        console.error('Could not load resume parse details:', err);
    }
    next();
}

module.exports = {
    LOW_TEXT_LENGTH,
    summarizeResumeParse,
    parseNotice,
    recordResumeParse,
    loadResumeParse
};
