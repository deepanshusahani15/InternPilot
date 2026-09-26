require("dotenv").config();

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Do NOT exit — a single fire-and-forget promise failure (e.g. a
    // background notification) must never take down the entire server.
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception thrown:', error);
    process.exit(1);
});

const express = require("express");
const ejsMate = require("ejs-mate");
const methodOverride = require("method-override");
const mongoose = require("mongoose");
const path = require("path");
const session = require("express-session");
const flash = require("connect-flash");
const passport = require("passport");

require("./config/passport");

const User = require("./models/User");
const Internship = require("./models/Internship");
const Notification = require('./models/Notification');
const { buildNavigationState } = require('./utils/navigation');
const { checkPmisEligibility } = require('./utils/pmisEligibility');
const { sanitizeHttpUrl } = require('./utils/safeUrl');

const authRoutes = require("./routes/auth");
const internshipRoutes = require("./routes/internships");
const userRoutes = require("./routes/user");
const candidateRoutes = require('./routes/candidate');
const companyRoutes = require('./routes/company');
const adminRoutes = require('./routes/admin');
const chatRoutes = require('./routes/chat');
const notificationRoutes = require('./routes/notifications');
const activityRoutes = require('./routes/activity');
const pagesRoutes = require('./routes/pages');
const analyticsRoutes = require('./routes/analytics');

const app = express();
const port = process.env.PORT || 8080;

// Safe URL normalization is available to templates that render stored links.
app.locals.sanitizeHttpUrl = sanitizeHttpUrl;

// View engine setup
app.engine("ejs", ejsMate);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride("_method"));
app.use(express.static(path.join(__dirname, "public")));

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || "supersecretkey",
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 * 7
    }
}));

// Passport & Flash middleware
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

// Local variables middleware
app.use(async (req, res, next) => {
    res.locals.currentUser = req.user;
    res.locals.currentPath = req.path;
    res.locals.navigation = buildNavigationState(req.path);
    res.locals.success_msg = req.flash("success_msg");
    res.locals.error_msg = req.flash("error_msg");
    res.locals.error = req.flash("error");
    res.locals.notificationUnreadCount = 0;
    res.locals.checkPmisEligibility = checkPmisEligibility;

    if (req.user) {
        try {
            const role = req.user.role;
            if (role === 'candidate') {
                res.locals.notificationUnreadCount = await Notification.countDocuments({
                    recipient: req.user._id,
                    isRead: false
                });
            } else if (role === 'company' || role === 'recruiter') {
                const targetCompanyId = role === 'company' ? req.user._id : req.user.companyId;
                res.locals.notificationUnreadCount = await Notification.countDocuments({
                    companyId: targetCompanyId,
                    isRead: false
                });
            }
        } catch (error) {
            // A notification lookup must never prevent the rest of the page
            // from loading while the feature is unavailable.
            console.error('Error loading notification count:', error);
        }
    }

    return next();
});

// Database connection
main()
    .then(() => console.log("MongoDB Connected Successfully"))
    .catch(err => console.log(err));

async function main() {
    await mongoose.connect(process.env.ATLASDB_URL);
}

// In-app messaging (#136). Mounted before every page route so its unread
// count is available to the header on all pages, the homepage included.
app.use(require('./routes/messages'));

// Resume parser details (#20) for the candidate profile page.
app.use(require('./routes/resumeParse'));

// Homepage Route (Renders views/extras/index.ejs)
app.get('/', async (req, res) => {
    try {
        const totalInternships = await Internship.countDocuments({ status: { $ne: 'draft' } });
        const totalCandidates = await User.countDocuments({ role: 'candidate' });
        const totalCompanies = await User.countDocuments({ role: 'company' });

        res.render('extras/index', { totalInternships, totalCandidates, totalCompanies });
    } catch (error) {
        console.error("Error rendering homepage:", error);
        res.render('extras/index', { totalInternships: 0, totalCandidates: 0, totalCompanies: 0 });
    }
});

// Application Routes
app.use('/', pagesRoutes);
app.use('/auth', authRoutes);
app.use('/internships', internshipRoutes);
app.use('/', userRoutes);
app.use('/', candidateRoutes);
app.use('/', companyRoutes);
app.use('/admin', adminRoutes);
app.use('/', chatRoutes);
app.use('/', notificationRoutes);
app.use('/', activityRoutes);
app.use('/api', activityRoutes);
app.use('/api/v1', analyticsRoutes);

// Ignore favicon requests to avoid noisy 404 logs in console
app.get('/favicon.ico', (req, res) => res.status(204).end());

// 404 Catch-All Handler (Forward to error handler)
app.use((req, res, next) => {
    const err = new Error(`Page Not Found: ${req.originalUrl}`);
    err.status = 404;
    next(err);
});

// Global Error Handler (Renders views/extras/error.ejs with safety fallback)
app.use((err, req, res, next) => {
    console.error('Express Error:', err.stack || err);
    if (res.headersSent) {
        return next(err);
    }

    const statusCode = err.status || 500;
    const errorMessage = err.message || 'Internal Server Error';

    res.status(statusCode).render('extras/error', {
        message: errorMessage,
        error: process.env.NODE_ENV === 'development' ? err : {}
    }, (renderErr, html) => {
        if (renderErr) {
            const safeMessage = String(errorMessage)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
            return res.status(statusCode).send(`
                <div style="font-family: sans-serif; padding: 2rem; max-width: 600px; margin: auto;">
                    <h2>Something went wrong (${statusCode})</h2>
                    <p><strong>Error:</strong> ${safeMessage}</p>
                    <a href="/">Return to Home</a>
                </div>
            `);
        }
        res.send(html);
    });
});

// Initialize background scheduler
require('./utils/scheduler');

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
