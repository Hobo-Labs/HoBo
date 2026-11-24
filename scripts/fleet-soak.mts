#!/usr/bin/env node
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
