#!/usr/bin/env node
/**
 * `pnpm run fleet:soak` (O20, design §10.1 "Soak output"; ADR-0183): brings up
 * `deploy/fleet/compose.ha.yml`, enrolls three agents, runs `oci-command`
 * work for ten minutes, kills one NATS server at minute 3 and one authority
 * at minute 6, and writes `fleet-soak.json` at the repository root. The run
 * itself is `packages/fleet-authority/acceptance/soak.ts`.
 *
 * Needs Docker Compose with a running daemon, `openssl`, and a host on which
 * the agent's S1 sandbox self-test passes (D58). Without Docker the soak
 * fails; it never skips.
 *
 * Settings (environment), for trying it out; `fleet:outcome O20` runs the
 * defaults:
 *   HOBO_FLEET_SOAK_DURATION_S         default 600
 *   HOBO_FLEET_SOAK_KILL_NATS_AT_S     default 180
 *   HOBO_FLEET_SOAK_KILL_AUTHORITY_AT_S default 360
 *   HOBO_FLEET_SOAK_OUT                default <repo>/fleet-soak.json
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	runSoak,
	SoakFailure,
} from "../packages/fleet-authority/acceptance/soak.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function seconds(name: string, fallback: number): number {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isFinite(value) || value < 0)
		throw new SoakFailure(`${name} must be a number of seconds`);
	return value;
}

try {
	const report = await runSoak({
		repoRoot,
		out: process.env.HOBO_FLEET_SOAK_OUT ?? join(repoRoot, "fleet-soak.json"),
		durationS: seconds("HOBO_FLEET_SOAK_DURATION_S", 600),
		killNatsAtS: seconds("HOBO_FLEET_SOAK_KILL_NATS_AT_S", 180),
		killAuthorityAtS: seconds("HOBO_FLEET_SOAK_KILL_AUTHORITY_AT_S", 360),
		say: (line) => process.stderr.write(`fleet-soak: ${line}\n`),
	});
	process.stdout.write(`${JSON.stringify(report, null, "\t")}\n`);
	process.exit(0);
} catch (error) {
	process.stderr.write(
		`fleet-soak: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exit(1);
}
