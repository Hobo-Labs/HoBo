#!/usr/bin/env node
/**
 * `hobo-fleet-witness --config <file>`: the witness of §6.14 (another
 * operating-system account in the standalone profile, another host in high
 * availability). Co-signs audit checkpoints and proposed trust records, and
 * runs until SIGTERM.
 *
 * It connects with the witness user's credentials, so its audit log writes
 * each co-signature to `fleet.audit.witness` (`publishOverAuditLog`).
 */
import { connectAuthorityBus } from "@hobo/fleet-nats";
import { composeWitness } from "../compose/witness.js";
import { boot, fail, onShutdown, stderrLog } from "./common.js";

const { config, secrets } = await boot(
	process.argv.slice(2),
	"usage: hobo-fleet-witness --config <file>",
);
const composed = await composeWitness(config, {
	secrets,
	now: () => Date.now(),
	log: stderrLog,
	connectBus: connectAuthorityBus,
});
if (!composed.ok) fail(composed.error.message);
const witness = composed.value;
witness.start();
stderrLog("hobo_fleet_bus_status", {
	component: "witness",
	status: "started",
});
onShutdown(() => witness.stop());
