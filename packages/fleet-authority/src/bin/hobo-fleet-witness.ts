#!/usr/bin/env node
/**
 * `hobo-fleet-witness --config <file>`: the witness of §6.14 (another
 * operating-system account in the standalone profile, another host in high
 * availability). Co-signs audit checkpoints and proposed trust records.
 *
 * Its co-signatures go to `fleet.audit.witness`, which @hobo/fleet-nats has
 * no entry point for yet (reported as a cascade delta to L08): until it does,
 * the witness refuses to start rather than run and sign nothing.
 */
import { connectAuthorityBus } from "@hobo/fleet-nats";
import { composeWitness } from "../compose/witness.js";
import { boot, fail, stderrLog } from "./common.js";

const { config, secrets } = await boot(
	process.argv.slice(2),
	"usage: hobo-fleet-witness --config <file>",
);
const composed = await composeWitness(config, {
	secrets,
	now: () => Date.now(),
	log: stderrLog,
	connectBus: connectAuthorityBus,
	async publish() {
		throw new Error("@hobo/fleet-nats has no witness publish entry point yet");
	},
});
if (!composed.ok) fail(composed.error.message);
// The composition (bus, key, registry changes) is proven; only the publish path is missing.
await composed.value.stop();
fail(
	"hobo-fleet-witness: @hobo/fleet-nats does not yet expose a publish path for fleet.audit.witness; refusing to run a witness that cannot co-sign",
);
