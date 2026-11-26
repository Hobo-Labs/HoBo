import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPactDirectory, verifyPact } from "@hobo/contract-harness";
import { describe, expect, it } from "vitest";

import {
	createProxiedRunProvider,
	PROVIDER_NAME,
} from "../support/proxied-run-provider.js";
import { resolveKit } from "./kit.js";
import { createRealRunner } from "./real-runner.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../contracts",
);

// Eight interactions, each played in a fresh sandbox (`pass init`, `pass insert`,
// `plugins install` hashing the plugin, a TLS upstream) one after another: the
// lane's 180 s is a budget for one run, and on a loaded machine (load 34 on four
// CPUs) the eight took 215 s.
const EIGHT_RUNS_MS = 600_000;

describe("the proxied-run pact, verified against the real opensesame", () => {
	it(
		"every interaction holds against the real binary and the plugin's test build",
		async () => {
			const kit = resolveKit(process.env);
			const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
			const pact = pacts.find(
				(candidate) => candidate.provider.name === PROVIDER_NAME,
			);
			if (pact === undefined)
				throw new Error("the proxied-run pact is missing");
			const report = await verifyPact(
				pact,
				createProxiedRunProvider(createRealRunner(kit)),
			);
			expect(report.failures).toEqual([]);
			expect(report.ok).toBe(true);
		},
		EIGHT_RUNS_MS,
	);
});
