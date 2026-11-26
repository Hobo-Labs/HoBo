#!/usr/bin/env node
/**
 * S1-22 stage gate: cold hobo dev on hello-bindle fixture serves HTTP 200 within 60s.
 * Draft POC uses @hobo-draft/hobo-612-dev-local-loop-poc until packages/cli lands.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { writeFixtureProject } from "../../packages/cli/src/codegen/fixture.js";
import {
	defineDevResource,
	startDevSession,
} from "../../src/draft/technical-proofs/hobo-612-dev-local-loop-poc/src/dev-session.js";
import { COLD_BOOT_BUDGET_MS } from "../../src/draft/technical-proofs/hobo-612-dev-local-loop-poc/src/types.js";
import { scaffoldHoboProject } from "../../src/draft/technical-proofs/hobo-new-scaffold-contract/src/scaffold.js";

const CREDENTIAL_ENV_VARS = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AZURE_CLIENT_ID",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GITHUB_TOKEN",
	"OPENAI_API_KEY",
];

async function main(): Promise<void> {
	for (const key of CREDENTIAL_ENV_VARS) {
		if (process.env[key]) {
			console.error(
				`credential env var must not be set for offline cold boot: ${key}`,
			);
			process.exit(1);
		}
	}

	const root = await mkdtemp(path.join(tmpdir(), "hobo-cold-loop-"));
	const started = performance.now();
	try {
		const { projectDir } = await scaffoldHoboProject({
			cwd: root,
			name: "hello-bindle",
			template: "api",
		});
		await writeFixtureProject(projectDir);

		const session = await startDevSession({
			projectRoot: projectDir,
			bootMs: Math.round(performance.now() - started),
			resources: [defineDevResource("api", "main")],
		});

		const response = await session.handleRequest({ path: "/health", body: {} });
		const elapsed = Math.round(performance.now() - started);

		if (response.status !== 200) {
			console.error(`expected HTTP 200, got ${response.status}`);
			process.exit(1);
		}
		if (elapsed > COLD_BOOT_BUDGET_MS) {
			console.error(
				`cold boot ${elapsed}ms exceeds budget ${COLD_BOOT_BUDGET_MS}ms`,
			);
			process.exit(1);
		}

		console.log(
			JSON.stringify({
				ok: true,
				localUrl: session.record.localUrl,
				elapsedMs: elapsed,
				budgetMs: COLD_BOOT_BUDGET_MS,
				cloudAccountRequired: session.record.cloudAccountRequired,
			}),
		);
		await session.stop();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
