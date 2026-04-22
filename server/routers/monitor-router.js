let express = require("express");
const { R } = require("redbean-node");
const { apiAuth, resolveUserFromApi } = require("../auth");
const { log, genSecret } = require("../../src/util");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const Monitor = require("../model/monitor");
const apicache = require("../modules/apicache");

let router = express.Router();

// All monitor REST endpoints require API auth + user resolution
router.use("/api/monitors", apiAuth, resolveUserFromApi);

/**
 * Sanitize monitor input: stringify JSON fields, remove frontend-only props,
 * derive accepted_statuscodes_json only from accepted_statuscodes.
 * @param {object} monitor Raw request body
 * @returns {object} Sanitized monitor data
 */
function sanitizeMonitorInput(monitor) {
    // Derive accepted_statuscodes_json only from accepted_statuscodes; block direct injection
    delete monitor.accepted_statuscodes_json;
    if (monitor.accepted_statuscodes) {
        if (!Array.isArray(monitor.accepted_statuscodes) ||
            !monitor.accepted_statuscodes.every((code) => typeof code === "string")) {
            throw new Error("accepted_statuscodes must be an array of strings");
        }
        monitor.accepted_statuscodes_json = JSON.stringify(monitor.accepted_statuscodes);
        delete monitor.accepted_statuscodes;
    }

    // Stringify JSON fields if provided as objects
    const jsonFields = ["kafkaProducerBrokers", "kafkaProducerSaslOptions", "conditions", "rabbitmqNodes"];
    for (const field of jsonFields) {
        if (monitor[field] !== undefined && typeof monitor[field] !== "string") {
            monitor[field] = JSON.stringify(monitor[field]);
        }
    }

    // Remove frontend-only properties
    const frontendOnlyProperties = ["humanReadableInterval", "globalpingdnsresolvetypeoptions", "responsecheck"];
    for (const prop of frontendOnlyProperties) {
        delete monitor[prop];
    }

    return monitor;
}

/**
 * Validate parent ownership and prevent cycles.
 * @param {number} parentID Proposed parent monitor ID
 * @param {number} userID Authenticated user ID
 * @param {number|null} selfID Current monitor ID (null for create)
 */
async function validateParent(parentID, userID, selfID) {
    if (parentID === null || parentID === undefined) {
        return;
    }

    let parentMonitor = await R.findOne("monitor", " id = ? AND user_id = ? ", [parentID, userID]);
    if (!parentMonitor) {
        throw new Error("Parent monitor not found or not owned by this user.");
    }
    if (parentMonitor.type !== "group") {
        throw new Error("Parent monitor must be of type 'group'.");
    }

    // Prevent self-referencing
    if (selfID !== null && parentID === selfID) {
        throw new Error("A monitor cannot be its own parent.");
    }

    // Prevent cycles: walk up the parent chain
    if (selfID !== null) {
        let allChildren = await Monitor.getAllChildrenIDs(selfID);
        if (allChildren.includes(parentID)) {
            throw new Error("Circular parent-child relationship detected.");
        }
    }
}

/**
 * GET /api/monitors — List all monitors for the authenticated user
 */
router.get("/api/monitors", async (req, res) => {
    try {
        const server = UptimeKumaServer.getInstance();
        let list = await server.getMonitorJSONList(req.userID);
        let monitors = Object.values(list).sort((a, b) => {
            let weightDiff = (b.weight ?? 0) - (a.weight ?? 0);
            if (weightDiff !== 0) {
                return weightDiff;
            }
            return (a.name || "").localeCompare(b.name || "");
        });
        res.json({ ok: true, monitors });
    } catch (e) {
        log.error("api-monitors", e.message);
        res.status(500).json({ ok: false, msg: e.message });
    }
});

/**
 * GET /api/monitors/:id — Get a single monitor
 */
router.get("/api/monitors/:id", async (req, res) => {
    try {
        const server = UptimeKumaServer.getInstance();
        let list = await server.getMonitorJSONList(req.userID, parseInt(req.params.id, 10));
        let monitor = list[req.params.id];
        if (!monitor) {
            return res.status(404).json({ ok: false, msg: "Monitor not found." });
        }
        res.json({ ok: true, monitor });
    } catch (e) {
        log.error("api-monitors", e.message);
        res.status(500).json({ ok: false, msg: e.message });
    }
});

/**
 * POST /api/monitors — Create a new monitor
 */
router.post("/api/monitors", async (req, res) => {
    try {
        const server = UptimeKumaServer.getInstance();
        let monitor = sanitizeMonitorInput(req.body);

        let bean = R.dispense("monitor");

        let notificationIDList = monitor.notificationIDList;
        delete monitor.notificationIDList;

        // Don't allow setting user_id or id from input
        delete monitor.user_id;
        delete monitor.id;

        bean.import(monitor);

        if (monitor.retryOnlyOnStatusCodeFailure !== undefined) {
            bean.retry_only_on_status_code_failure = monitor.retryOnlyOnStatusCodeFailure;
        }

        bean.user_id = req.userID;

        // Validate parent ownership and prevent cycles
        if (bean.parent) {
            await validateParent(bean.parent, req.userID, null);
        }

        // Server-side pushToken generation for push monitors
        if (bean.type === "push" && !bean.pushToken) {
            bean.pushToken = genSecret(32);
        }

        bean.validate();
        await R.store(bean);

        if (notificationIDList) {
            await updateMonitorNotification(bean.id, notificationIDList);
        }

        if (monitor.active !== false) {
            await startMonitor(req.userID, bean.id);
        }

        log.info("api-monitors", `Created monitor ${bean.id} for user ${req.userID}`);

        let list = await server.getMonitorJSONList(req.userID, bean.id);
        res.status(201).json({
            ok: true,
            msg: "successAdded",
            monitorID: bean.id,
            monitor: list[bean.id],
        });
    } catch (e) {
        log.error("api-monitors", e.message);
        res.status(400).json({ ok: false, msg: e.message });
    }
});

/**
 * PUT /api/monitors/:id — Update an existing monitor
 */
router.put("/api/monitors/:id", async (req, res) => {
    try {
        const server = UptimeKumaServer.getInstance();
        let monitorID = parseInt(req.params.id, 10);
        let bean = await R.findOne("monitor", " id = ? AND user_id = ? ", [monitorID, req.userID]);
        if (!bean) {
            return res.status(404).json({ ok: false, msg: "Monitor not found." });
        }

        let previousActive = bean.active;
        let previousType = bean.type;
        let monitor = sanitizeMonitorInput(req.body);

        let notificationIDList = monitor.notificationIDList;
        delete monitor.notificationIDList;

        // Don't allow changing user_id or id
        delete monitor.user_id;
        delete monitor.id;

        bean.import(monitor);

        if (monitor.retryOnlyOnStatusCodeFailure !== undefined) {
            bean.retry_only_on_status_code_failure = monitor.retryOnlyOnStatusCodeFailure;
        }

        // Validate parent ownership and prevent cycles
        if (monitor.parent !== undefined) {
            await validateParent(bean.parent, req.userID, monitorID);
        }

        // Handle type change from group to non-group: unlink children
        if (previousType === "group" && bean.type !== "group") {
            await R.exec("UPDATE monitor SET parent = NULL WHERE parent = ? ", [monitorID]);
        }

        bean.validate();
        await R.store(bean);

        if (notificationIDList) {
            await updateMonitorNotification(bean.id, notificationIDList);
        }

        // Handle active state transitions
        if (bean.active && !previousActive) {
            await startMonitor(req.userID, bean.id);
        } else if (!bean.active && previousActive) {
            await pauseMonitor(req.userID, bean.id);
        } else if (bean.active) {
            await restartMonitor(req.userID, bean.id);
        }

        log.info("api-monitors", `Updated monitor ${bean.id} for user ${req.userID}`);

        let list = await server.getMonitorJSONList(req.userID, bean.id);
        res.json({
            ok: true,
            msg: "successEdited",
            monitorID: bean.id,
            monitor: list[bean.id],
        });
    } catch (e) {
        log.error("api-monitors", e.message);
        res.status(400).json({ ok: false, msg: e.message });
    }
});

/**
 * DELETE /api/monitors/:id — Delete a monitor
 */
router.delete("/api/monitors/:id", async (req, res) => {
    try {
        let monitorID = parseInt(req.params.id, 10);
        let bean = await R.findOne("monitor", " id = ? AND user_id = ? ", [monitorID, req.userID]);
        if (!bean) {
            return res.status(404).json({ ok: false, msg: "Monitor not found." });
        }

        let deleteChildren = req.query.deleteChildren === "true";
        if (deleteChildren) {
            await Monitor.deleteMonitorRecursively(monitorID, req.userID);
        } else {
            if (bean.type === "group") {
                await R.exec("UPDATE monitor SET parent = NULL WHERE parent = ? ", [monitorID]);
            }
            await Monitor.deleteMonitor(monitorID, req.userID);
        }

        apicache.clear();

        log.info("api-monitors", `Deleted monitor ${monitorID} for user ${req.userID}`);
        res.json({ ok: true, msg: "successDeleted" });
    } catch (e) {
        log.error("api-monitors", e.message);
        res.status(500).json({ ok: false, msg: e.message });
    }
});

/**
 * Helper: update monitor notification links (same as server.js)
 * @param {number} monitorID Monitor ID
 * @param {object} notificationIDList Notification ID list
 */
async function updateMonitorNotification(monitorID, notificationIDList) {
    await R.exec("DELETE FROM monitor_notification WHERE monitor_id = ? ", [monitorID]);
    for (let notificationID in notificationIDList) {
        if (notificationIDList[notificationID]) {
            let relation = R.dispense("monitor_notification");
            relation.monitor_id = monitorID;
            relation.notification_id = notificationID;
            await R.store(relation);
        }
    }
}

/**
 * Helper: start a monitor (mirrors server.js startMonitor)
 * @param {number} userID User ID
 * @param {number} monitorID Monitor ID
 */
async function startMonitor(userID, monitorID) {
    const server = UptimeKumaServer.getInstance();
    await R.exec("UPDATE monitor SET active = 1 WHERE id = ? AND user_id = ? ", [monitorID, userID]);
    let monitor = await R.findOne("monitor", " id = ? ", [monitorID]);
    if (monitor.id in server.monitorList) {
        await server.monitorList[monitor.id].stop();
    }
    server.monitorList[monitor.id] = monitor;
    await monitor.start(server.io);
}

/**
 * Helper: restart a monitor
 * @param {number} userID User ID
 * @param {number} monitorID Monitor ID
 */
async function restartMonitor(userID, monitorID) {
    return await startMonitor(userID, monitorID);
}

/**
 * Helper: pause a monitor (mirrors server.js pauseMonitor)
 * @param {number} userID User ID
 * @param {number} monitorID Monitor ID
 */
async function pauseMonitor(userID, monitorID) {
    const server = UptimeKumaServer.getInstance();
    await R.exec("UPDATE monitor SET active = 0 WHERE id = ? AND user_id = ? ", [monitorID, userID]);
    if (monitorID in server.monitorList) {
        await server.monitorList[monitorID].stop();
        server.monitorList[monitorID].active = 0;
    }
}

module.exports = router;
