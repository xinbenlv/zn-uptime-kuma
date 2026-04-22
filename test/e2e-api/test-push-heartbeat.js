// End-to-end API test: create a push monitor, POST a heartbeat, assert it landed.
//
// Boots the real server.js in-process against an ephemeral port + throwaway
// data dir, seeds a user and API key directly in the DB, then exercises the
// REST API over HTTP. See server/server.js `module.exports.ready` for the
// test hook this file relies on.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.resolve(__dirname, "../../data/test-e2e-api");

process.env.UPTIME_KUMA_PORT = "0";
process.env.UPTIME_KUMA_TEST = "1";
process.env.DATA_DIR = DATA_DIR;
process.env.NODE_ENV = "development";
// Skip the interactive setup-database UI: tell the server to use SQLite directly.
process.env.UPTIME_KUMA_DB_TYPE = "sqlite";
// Silence the chattier log channels; leave warn/error visible for diagnosis.
process.env.UPTIME_KUMA_HIDE_LOG = [
    "info_db",
    "info_server",
    "info_monitor",
    "debug_monitor",
    "info_api-monitors",
].join(",");

// Wipe any leftover DB so each run starts clean.
fs.rmSync(DATA_DIR, { recursive: true, force: true });

const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { R } = require("redbean-node");
const { nanoid } = require("nanoid");

// Requiring server.js fires its boot IIFE (DB init, routes, listen).
const serverModule = require("../../server/server");

const passwordHash = require("../../server/password-hash");
const { Settings } = require("../../server/settings");
const { UptimeKumaServer } = require("../../server/uptime-kuma-server");

const BOOT_TIMEOUT_MS = 30_000;

/**
 * Seed a user + active API key. Returns the formatted key to use as the
 * HTTP Basic password on subsequent API calls.
 * @returns {Promise<{userID: number, formattedKey: string}>}
 */
async function seedUserAndApiKey() {
    let user = R.dispense("user");
    user.username = "e2eadmin";
    user.password = await passwordHash.generate("e2epass");
    user.active = 1;
    await R.store(user);

    const clearKey = nanoid(40);
    const hashedKey = await passwordHash.generate(clearKey);

    let apiKey = R.dispense("api_key");
    apiKey.key = hashedKey;
    apiKey.name = "e2e-test-key";
    apiKey.user_id = user.id;
    apiKey.active = 1;
    apiKey.expires = "2099-12-31 00:00:00";
    await R.store(apiKey);

    await Settings.set("apiKeysEnabled", true);

    return {
        userID: user.id,
        formattedKey: "uk" + apiKey.id + "_" + clearKey,
    };
}

/**
 * Basic Auth header for an API key (empty user, key as password).
 * @param {string} formattedKey
 * @returns {string}
 */
function authHeader(formattedKey) {
    return "Basic " + Buffer.from(":" + formattedKey).toString("base64");
}

describe("E2E: push monitor heartbeat over REST API", () => {
    let baseURL;
    let seeded;

    before(async () => {
        const ready = Promise.race([
            serverModule.ready,
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error("server did not become ready in time")), BOOT_TIMEOUT_MS)
            ),
        ]);
        const { port } = await ready;
        baseURL = `http://127.0.0.1:${port}`;
        seeded = await seedUserAndApiKey();
    });

    after(async () => {
        // Stop any running monitor beat loops so their setTimeouts don't
        // keep the process alive past test completion.
        const server = UptimeKumaServer.getInstance();
        for (const id of Object.keys(server.monitorList)) {
            try {
                await server.monitorList[id].stop();
            } catch {
                // best-effort teardown
            }
        }

        Settings.stopCacheCleaner();

        await new Promise((resolve) => server.httpServer.close(() => resolve()));

        // Hard exit: the server has background intervals (version check,
        // etc.) that don't expose unref handles. Give assertions a beat to
        // flush, then terminate so CI doesn't hang.
        setTimeout(() => process.exit(0), 100).unref();
    });

    test("create push monitor, post heartbeat, heartbeat row is present", async () => {
        const createRes = await fetch(`${baseURL}/api/monitors`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": authHeader(seeded.formattedKey),
            },
            body: JSON.stringify({
                name: "e2e push monitor",
                type: "push",
                interval: 60,
                retryInterval: 60,
                maxretries: 0,
                active: true,
            }),
        });

        assert.strictEqual(createRes.status, 201, "POST /api/monitors should return 201");
        const createBody = await createRes.json();
        assert.strictEqual(createBody.ok, true);
        assert.ok(createBody.monitorID, "response should include monitorID");
        assert.ok(createBody.monitor.pushToken, "push monitor should have a pushToken");

        const monitorID = createBody.monitorID;
        const pushToken = createBody.monitor.pushToken;

        const pushRes = await fetch(
            `${baseURL}/api/push/${pushToken}?status=up&ping=42&msg=e2e-ok`
        );
        assert.strictEqual(pushRes.status, 200, "push endpoint should return 200");
        const pushBody = await pushRes.json();
        assert.strictEqual(pushBody.ok, true, "push endpoint should ack ok:true");

        // The handler writes the heartbeat row synchronously before responding,
        // so this read does not need to poll.
        const hb = await R.findOne(
            "heartbeat",
            " monitor_id = ? ORDER BY time DESC",
            [monitorID]
        );
        assert.ok(hb, "a heartbeat row should exist for the monitor");
        assert.strictEqual(hb.status, 1, "heartbeat status should be UP (1)");
        assert.strictEqual(hb.ping, 42, "heartbeat ping should match query param");
        assert.strictEqual(hb.msg, "e2e-ok", "heartbeat msg should match query param");
    });

    test("push to unknown token returns 404", async () => {
        const res = await fetch(`${baseURL}/api/push/this-token-does-not-exist?status=up`);
        assert.strictEqual(res.status, 404);
        const body = await res.json();
        assert.strictEqual(body.ok, false);
    });
});
