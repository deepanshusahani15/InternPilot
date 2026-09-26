const express = require('express');
const router = express.Router();
const { loadResumeParse } = require('../utils/resumeParse');

// Mounted ahead of routes/user.js. It only adds the latest parse to
// res.locals and hands over to the real profile route with next().
router.get('/candidate/profile', loadResumeParse);

module.exports = router;
