process.env.UPTIME_KUMA_HIDE_LOG = ["info_db", "info_server"].join(",");

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const passwordHash = require("../../server/password-hash");
const { Settings } = require("../../server/settings");

const testDb = new TestDB("./data/test-monitor-api");

/**
 * Create a test user and API key.
 * @returns {Promise<{user: object, apiKey: object, clearKey: string, formattedKey: string}>} Seeded fixtures for a single test user.
 */
async function seedUserAndApiKey() {
    let user = R.dispense("user");
    user.username = "testadmin";
    user.password = await passwordHash.generate("testpass123");
    user.active = 1;
    await R.store(user);

    const { nanoid } = require("nanoid");
    let clearKey = nanoid(40);
    let hashedKey = await passwordHash.generate(clearKey);

    let apiKey = R.dispense("api_key");
    apiKey.key = hashedKey;
    apiKey.name = "test-key";
    apiKey.user_id = user.id;
    apiKey.active = 1;
    apiKey.expires = "2099-12-31 00:00:00";
    await R.store(apiKey);

    await Settings.set("apiKeysEnabled", true);

    let formattedKey = "uk" + apiKey.id + "_" + clearKey;
    return { user, apiKey, clearKey, formattedKey };
}

describe("Monitor REST API", () => {
    let resolveUserFromApi;
    let testData;

    before(async () => {
        await testDb.create();
        resolveUserFromApi = require("../../server/auth").resolveUserFromApi;
        testData = await seedUserAndApiKey();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDb.destroy();
    });

    // ── resolveUserFromApi middleware tests ──

    test("resolves user_id from API key", async () => {
        let resolvedUserID = null;
        let statusCode = null;

        const req = {
            auth: { user: "", password: testData.formattedKey },
        };
        const res = {
            status(code) {
                statusCode = code;
                return this;
            },
            json() {},
        };

        await resolveUserFromApi(req, res, () => {
            resolvedUserID = req.userID;
        });

        assert.strictEqual(resolvedUserID, testData.user.id, "req.userID should match the test user's ID");
        assert.strictEqual(statusCode, null, "should not set an error status code");
    });

    test("resolves user_id from username/password when API keys disabled", async () => {
        await Settings.set("apiKeysEnabled", false);

        let resolvedUserID = null;
        const req = {
            auth: { user: "testadmin", password: "testpass123" },
        };
        const res = {
            status() { return this; },
            json() {},
        };

        await resolveUserFromApi(req, res, () => {
            resolvedUserID = req.userID;
        });

        assert.strictEqual(resolvedUserID, testData.user.id);
        await Settings.set("apiKeysEnabled", true);
    });

    test("returns 401 for invalid API key index", async () => {
        let statusCode = null;
        let responseBody = null;

        const req = {
            auth: { user: "", password: "uk99999_fakeclearkey" },
        };
        const res = {
            status(code) {
                statusCode = code;
                return this;
            },
            json(body) { responseBody = body; },
        };

        await resolveUserFromApi(req, res, () => {
            assert.fail("next() should not be called for invalid API key");
        });

        assert.strictEqual(statusCode, 401);
        assert.strictEqual(responseBody.ok, false);
    });

    test("returns 401 when no auth data provided", async () => {
        let statusCode = null;
        let responseBody = null;

        const req = {};
        const res = {
            status(code) {
                statusCode = code;
                return this;
            },
            json(body) { responseBody = body; },
        };

        await resolveUserFromApi(req, res, () => {
            assert.fail("next() should not be called without auth");
        });

        assert.strictEqual(statusCode, 401);
        assert.strictEqual(responseBody.ok, false);
    });

    test("resolves single user when auth is disabled", async () => {
        await Settings.set("disableAuth", true);

        let resolvedUserID = null;
        const req = {};
        const res = {
            status() { return this; },
            json() {},
        };

        await resolveUserFromApi(req, res, () => {
            resolvedUserID = req.userID;
        });

        assert.strictEqual(resolvedUserID, testData.user.id);
        await Settings.set("disableAuth", false);
    });

    // ── Monitor CRUD logic tests ──

    test("creates a push monitor with server-generated pushToken", async () => {
        const { genSecret } = require("../../src/util");

        let bean = R.dispense("monitor");
        bean.name = "Test Push Monitor";
        bean.type = "push";
        bean.interval = 60;
        bean.retryInterval = 60;
        bean.user_id = testData.user.id;
        bean.active = 1;

        // Simulate router logic: generate pushToken if push type and not provided
        if (bean.type === "push" && !bean.pushToken) {
            bean.pushToken = genSecret(32);
        }

        bean.validate();
        await R.store(bean);

        assert.ok(bean.id, "monitor should have an ID after store");
        assert.ok(bean.pushToken, "push monitor should have a pushToken");
        assert.strictEqual(bean.pushToken.length, 32, "pushToken should be 32 characters");

        // Verify it's retrievable
        let found = await R.findOne("monitor", " id = ? AND user_id = ? ", [bean.id, testData.user.id]);
        assert.ok(found, "monitor should be found in DB");
        assert.strictEqual(found.name, "Test Push Monitor");
        assert.strictEqual(found.type, "push");
    });

    test("does not overwrite user-provided pushToken", async () => {
        const { genSecret } = require("../../src/util");
        let customToken = genSecret(32);

        let bean = R.dispense("monitor");
        bean.name = "Custom Token Monitor";
        bean.type = "push";
        bean.interval = 120;
        bean.retryInterval = 60;
        bean.pushToken = customToken;
        bean.user_id = testData.user.id;
        bean.active = 1;

        if (bean.type === "push" && !bean.pushToken) {
            bean.pushToken = genSecret(32);
        }

        bean.validate();
        await R.store(bean);

        assert.strictEqual(bean.pushToken, customToken, "should keep user-provided pushToken");
    });

    test("validates monitor interval bounds", async () => {
        let bean = R.dispense("monitor");
        bean.name = "Bad Interval Monitor";
        bean.type = "http";
        bean.url = "https://example.com";
        bean.interval = 0;
        bean.retryInterval = 20;
        bean.user_id = testData.user.id;

        assert.throws(() => bean.validate(), {
            message: /Interval cannot be less than/,
        });
    });

    test("ownership isolation — cannot find other user's monitor", async () => {
        let bean = R.dispense("monitor");
        bean.name = "User1 Monitor";
        bean.type = "http";
        bean.url = "https://example.com";
        bean.interval = 60;
        bean.retryInterval = 60;
        bean.user_id = testData.user.id;
        bean.active = 1;
        bean.validate();
        await R.store(bean);

        // Different user cannot see it
        let found = await R.findOne("monitor", " id = ? AND user_id = ? ", [bean.id, 99999]);
        assert.strictEqual(found, null, "should not find monitor belonging to another user");

        // Correct user can
        let correct = await R.findOne("monitor", " id = ? AND user_id = ? ", [bean.id, testData.user.id]);
        assert.ok(correct, "should find monitor for the correct user");
    });

    test("deletes a monitor", async () => {
        let bean = R.dispense("monitor");
        bean.name = "To Delete";
        bean.type = "http";
        bean.url = "https://example.com";
        bean.interval = 60;
        bean.retryInterval = 60;
        bean.user_id = testData.user.id;
        bean.active = 0;
        bean.validate();
        await R.store(bean);

        let monitorID = bean.id;
        await R.exec("DELETE FROM monitor WHERE id = ? AND user_id = ? ", [monitorID, testData.user.id]);

        let found = await R.findOne("monitor", " id = ? ", [monitorID]);
        assert.strictEqual(found, null, "monitor should be deleted");
    });
});
