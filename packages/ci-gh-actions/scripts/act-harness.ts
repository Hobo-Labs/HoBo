import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { create } from "@bufbuild/protobuf";
import { OfferSchema } from "@hobo/ci";
import { z } from "zod";
import { createHostedRelayRuntime } from "../src/hosted-runtime.js";
import { createRelayHandler } from "../src/http-handler.js";
import { createNodeRelayHandler } from "../src/node-http.js";
import { harness, NOW, queued, SECRET, signed } from "../test/fixtures.js";

const Provider = z.enum([
	"github",
	"blacksmith",
	"depot",
	"warpbuild",
	"kubernetes",
	"local",
]);
const Scenario = z.object({
	name: z.string().regex(/^[a-z-]+$/),
	expectedProvider: Provider.or(z.literal("")),
	accountBudgetMicros: z.number().int().nonnegative().optional(),
	offers: z.array(
		z.object({
			provider: Provider,
			freeMinutes: z.number().nonnegative(),
			priceMicros: z.number().int().nonnegative(),
			budgetMicros: z.number().int().nonnegative(),
		}),
	),
});
const Log = z.object({
	jobID: z.string().optional(),
	jobResult: z.string().optional(),
	dryrun: z.boolean().optional(),
	matrix: z.record(z.string(), z.string()).optional(),
	stepResult: z.string().optional(),
	stepID: z.array(z.string()).optional(),
});
const expectedJobs = [
	"expected_failure",
	"matrix:alpha",
	"matrix:beta",
	"prepare",
	"verify",
];
const expectedEvents = [
	"expected-failure",
	"matrix-alpha",
	"matrix-beta",
	"prepare",
	"verify",
];
const labels = {
	github: "ubuntu-24.04",
	blacksmith: "blacksmith-2vcpu-ubuntu-2404",
	depot: "depot-ubuntu-24.04",
	warpbuild: "warp-ubuntu-latest-x64-2x",
	kubernetes: "hobo-ci-isolated-k8s-host",
	local: "hobo-local-host",
};
const here = dirname(fileURLToPath(import.meta.url));

function requireEqual(actual: string, expected: string, reason: string): void {
	if (actual !== expected)
		throw new Error(`${reason}: expected ${expected}, received ${actual}`);
}
/** Refuse act's successful exit when it skipped unsupported labels or matrix rows. */
export function assertActEvidence(logs: string, events: string): number {
	const parsed = logs
		.split("\n")
		.filter((line) => line.trim().startsWith("{"))
		.map((line) => Log.parse(JSON.parse(line)));
	const jobs = parsed.filter((entry) => entry.jobResult !== undefined);
	const identities = jobs
		.map((entry) =>
			entry.jobID === "matrix" ? `matrix:${entry.matrix?.shard}` : entry.jobID,
		)
		.sort();
	requireEqual(
		JSON.stringify(identities),
		JSON.stringify(expectedJobs),
		"workflow jobs were skipped, duplicated or changed",
	);
	if (
		jobs.some(
			(entry) => entry.jobResult !== "success" || entry.dryrun !== false,
		)
	)
		throw new Error("act did not execute every job successfully");
	const failedSteps = parsed.filter((entry) => entry.stepResult === "failure");
	if (
		failedSteps.length !== 1 ||
		failedSteps[0]?.jobID !== "expected_failure" ||
		failedSteps[0]?.stepID?.[0] !== "failure"
	)
		throw new Error(
			"expected continue-on-error failure did not execute exactly once",
		);
	requireEqual(
		JSON.stringify(events.trim().split("\n").sort()),
		JSON.stringify(expectedEvents),
		"workflow evidence was skipped, duplicated or changed",
	);
	return jobs.length;
}
function command(
	binary: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile(
			binary,
			args,
			{
				cwd,
				env,
				timeout: 120000,
				maxBuffer: 8 * 1024 * 1024,
				encoding: "utf8",
			},
			(error, stdout, stderr) => {
				if (error) {
					reject(
						new Error(
							`${binary} failed: ${String(stdout).slice(-2000)} ${String(stderr).slice(-2000)}`,
						),
					);
					return;
				}
				resolvePromise(`${stdout}\n${stderr}`);
			},
		);
	});
}
function nativeEnvironment(root: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		XDG_CACHE_HOME: join(root, "cache"),
		XDG_CONFIG_HOME: join(root, "config"),
	};
	for (const name of [
		"PATH",
		"HOME",
		"USER",
		"SHELL",
		"LANG",
		"TMPDIR",
		"SSL_CERT_FILE",
		"NODE_EXTRA_CA_CERTS",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
	])
		if (process.env[name] !== undefined) env[name] = process.env[name];
	return env;
}
export async function runActHarness(options: {
	binary: string;
	evidenceDirectory?: string;
}) {
	const owned = options.evidenceDirectory === undefined;
	const base = options.evidenceDirectory
		? resolve(options.evidenceDirectory)
		: tmpdir();
	await mkdir(base, { recursive: true });
	const root = await mkdtemp(join(base, "hobo-ci-act-"));
	const binary = options.binary.includes("/")
		? resolve(options.binary)
		: options.binary;
	const sourceWorkflow = join(here, "../act/workflow.yml");
	const workflowBytes = await readFile(sourceWorkflow);
	const workflowDigest = createHash("sha256")
		.update(workflowBytes)
		.digest("hex");
	const scenarios = z
		.array(Scenario)
		.parse(
			JSON.parse(await readFile(join(here, "../act/scenarios.json"), "utf8")),
		);
	const results = [];
	const environment = nativeEnvironment(root);
	try {
		const version = await command(binary, ["--version"], root, environment);
		if (!version.includes("act version 0.2.89"))
			throw new Error(
				"this harness is pinned to act v0.2.89; verify a new version before changing the pin",
			);
		for (const scenario of scenarios) {
			const state = harness();
			// The relay as a host serves it: durable inbox, shared HTTP handler.
			const runtime = createHostedRelayRuntime({
				store: state.ledger,
				github: state.api,
				identity: state.relay.options.identity,
				webhookSecret: SECRET,
				control: async () => undefined,
				now: () => state.clock.now,
			});
			const server = createServer(
				createNodeRelayHandler({
					origin: "https://relay.example",
					handle: createRelayHandler({
						application: runtime,
						webhookSecret: SECRET,
						now: () => state.clock.now,
					}),
				}),
			);
			try {
				const account = state.configuration.accounts[0];
				if (!account) throw new Error("fixture account missing");
				account.budgetMicros = scenario.accountBudgetMicros ?? 1000000;
				account.offers = scenario.offers.map((offer) =>
					create(OfferSchema, {
						id: `${offer.provider}-act`,
						provider: offer.provider,
						providerAccountId: `owned-${offer.provider}-account`,
						enabled: true,
						runsOn: labels[offer.provider],
						freeMinutes: offer.freeMinutes,
						priceMicrosPerMinute: offer.priceMicros,
						budgetMicros: offer.budgetMicros,
						concurrency: 1,
						observedAt: "2026-10-26T00:00:00Z",
						validUntil: "2026-10-27T00:00:00Z",
						sourceUrl: "https://example.test/local-contract-evidence",
						bridgeAcknowledged: true,
						// A stored policy names the bridge backend for these two hosts.
						backend:
							offer.provider === "local" || offer.provider === "kubernetes"
								? "gh-actions"
								: "",
					}),
				);
				const listening = once(server, "listening");
				server.listen(0, "127.0.0.1");
				await listening;
				const port = z
					.object({ port: z.number().int().positive() })
					.parse(server.address()).port;
				const request = signed(queued());
				const response = await fetch(
					`http://127.0.0.1:${port}/github/webhooks`,
					{
						method: "POST",
						headers: {
							"x-github-event": "workflow_job",
							"x-github-delivery": `act-${scenario.name}`,
							"x-hub-signature-256": request.signature,
						},
						body: request.body,
					},
				);
				requireEqual(String(response.status), "202", "signed webhook intake");
				requireEqual(
					JSON.stringify(await response.json()),
					'{"status":"accepted"}',
					"signed delivery committed to the inbox",
				);
				// The worker tick admits the delivery, reserves a host and dispatches
				// it; the provider fixture records the lease it is sent.
				state.api.strictLeaseId = false;
				if (scenario.expectedProvider !== "")
					state.api.hostLabel = labels[scenario.expectedProvider];
				await runtime.tick();
				const lease = state.store.all()[0];
				if (scenario.expectedProvider === "") {
					if (lease || state.store.pendingJobs().length !== 1)
						throw new Error(
							"denied account launched a lease or lost pending demand",
						);
					await runtime.tick();
					requireEqual(
						String(state.api.dispatches),
						"0",
						"budget refusal launched provider",
					);
					results.push({
						scenario: scenario.name,
						provider: "",
						jobs: 0,
						denied: true,
					});
					continue;
				}
				if (!lease) throw new Error("eligible account has no lease");
				requireEqual(
					lease.provider,
					scenario.expectedProvider,
					"provider selection",
				);
				requireEqual(state.api.leaseId, lease.id, "dispatched lease identity");
				state.api.host.display_title = `HoBo lease ${lease.id}`;
				requireEqual(
					String(state.api.dispatches),
					"1",
					"provider dispatch count",
				);
				requireEqual(
					state.store.get(lease.id)?.state ?? "missing",
					"dispatched",
					"provider dispatch contract",
				);
				requireEqual(
					JSON.stringify(state.api.violations),
					"[]",
					"unmatched provider requests",
				);
				const workspace = join(root, scenario.name);
				const evidence = join(workspace, "evidence");
				await mkdir(evidence, { recursive: true });
				const workflow = join(workspace, "workflow.yml");
				await cp(sourceWorkflow, workflow);
				requireEqual(
					createHash("sha256")
						.update(await readFile(workflow))
						.digest("hex"),
					workflowDigest,
					"provider altered the original workflow",
				);
				await command(
					"git",
					["init", "--initial-branch=main"],
					workspace,
					environment,
				);
				await command(
					"git",
					[
						"-c",
						"user.name=HoBo CI fixture",
						"-c",
						"user.email=fixture@example.test",
						"commit",
						"--allow-empty",
						"-m",
						"fixture",
					],
					workspace,
					environment,
				);
				const logs = await command(
					binary,
					[
						"workflow_dispatch",
						"--directory",
						workspace,
						"--workflows",
						workflow,
						"--platform",
						"hobo=-self-hosted",
						"--action-cache-path",
						join(root, "cache"),
						"--cache-server-path",
						join(root, "cache-server"),
						"--no-cache-server",
						"--env-file",
						"/dev/null",
						"--secret-file",
						"/dev/null",
						"--input-file",
						"/dev/null",
						"--action-offline-mode",
						"--pull=false",
						"--json",
						"--env",
						`HOBO_CI_EVIDENCE=${evidence}`,
						"--env",
						`HOBO_CI_PROVIDER=${lease.provider}`,
						"--env",
						`HOBO_CI_EXPECTED_PROVIDER=${scenario.expectedProvider}`,
					],
					workspace,
					environment,
				);
				await writeFile(join(workspace, "act.log"), logs);
				const jobs = assertActEvidence(
					logs,
					await readFile(join(evidence, "events"), "utf8"),
				);
				requireEqual(
					await readFile(join(evidence, "alpha.txt"), "utf8"),
					"artifact-alpha\n",
					"matrix alpha artifact",
				);
				requireEqual(
					await readFile(join(evidence, "beta.txt"), "utf8"),
					"artifact-beta\n",
					"matrix beta artifact",
				);
				state.api.jobStatus = "completed";
				state.api.host.status = "completed";
				await state.relay.reconcile(lease.id, 22);
				requireEqual(
					state.store.get(lease.id)?.state ?? "missing",
					"completed",
					"provider host settlement",
				);
				results.push({
					scenario: scenario.name,
					provider: lease.provider,
					jobs,
					denied: false,
				});
			} finally {
				await new Promise<void>((resolvePromise) =>
					server.close(() => resolvePromise()),
				);
				state.store.close();
				state.ledger.close();
			}
		}
		const summary = {
			evidenceDirectory: owned ? undefined : root,
			actVersion: "0.2.89",
			workflowDigest,
			completedJobs: results.reduce((sum, result) => sum + result.jobs, 0),
			scenarios: results,
			fixtureTime: NOW,
		};
		await writeFile(
			join(root, "summary.json"),
			`${JSON.stringify(summary, null, 2)}\n`,
		);
		return summary;
	} finally {
		if (owned) await rm(root, { recursive: true, force: true });
	}
}
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	const parsed = parseArgs({
		options: { act: { type: "string" }, evidence: { type: "string" } },
		strict: true,
	});
	const binary = parsed.values.act ?? process.env.HOBO_CI_ACT_BIN ?? "act";
	runActHarness(
		parsed.values.evidence
			? { binary, evidenceDirectory: parsed.values.evidence }
			: { binary },
	)
		.then((result) =>
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
		)
		.catch((error) => {
			process.stderr.write(
				`${error instanceof Error ? error.message : "act harness failed"}\n`,
			);
			process.exitCode = 1;
		});
}
