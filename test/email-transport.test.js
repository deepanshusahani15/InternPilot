const test = require('node:test');
const assert = require('node:assert/strict');

const { sendOTPEmail } = require('../utils/sendEmail');

function restoreEnvironment(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

test('development console transport logs an OTP without contacting SMTP', async () => {
    const originalTransport = process.env.EMAIL_TRANSPORT;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalLog = console.log;
    const logs = [];
    process.env.EMAIL_TRANSPORT = 'console';
    delete process.env.NODE_ENV;
    console.log = message => logs.push(message);

    try {
        const result = await sendOTPEmail('tester@example.test', '123456');
        assert.equal(result.accepted[0], 'tester@example.test');
        assert.match(result.messageId, /^console-/);
        assert.match(logs[0], /DEVELOPMENT OTP for tester@example\.test: 123456/);
    } finally {
        console.log = originalLog;
        restoreEnvironment('EMAIL_TRANSPORT', originalTransport);
        restoreEnvironment('NODE_ENV', originalNodeEnv);
    }
});

test('console transport is rejected in production', async () => {
    const originalTransport = process.env.EMAIL_TRANSPORT;
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.EMAIL_TRANSPORT = 'console';
    process.env.NODE_ENV = 'production';

    try {
        await assert.rejects(
            () => sendOTPEmail('tester@example.test', '123456'),
            /cannot be used in production/
        );
    } finally {
        restoreEnvironment('EMAIL_TRANSPORT', originalTransport);
        restoreEnvironment('NODE_ENV', originalNodeEnv);
    }
});
