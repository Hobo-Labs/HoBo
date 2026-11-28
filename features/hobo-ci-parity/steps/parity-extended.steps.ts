import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { create } from "@bufbuild/protobuf";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import * as Effect from "effect/Effect";
import { z } from "zod";
import {
	answerRelayJob,
	HOSTED_RUNNER_PROVIDERS,
	JobFactSchema,
	LeaseSchema,
	NO_ROUTE_FACTS,
	type RelayJobAnswer,
	registryMachineCandidates,
	removeMachine,
	RunnerRouteEventSchema,
	RunnerRouteRequestSchema,
	type SpendReader,
} from "../../../packages/ci/src/index.js";
import {
	ciSignals,
	type InsightRun,
} from "../../../packages/ci/src/insights/index.js";
import { generateMachineIdentity } from "../../../packages/ci/src/runner-order/machine-identity.js";
import { SqliteMachineRegistry } from "../../../packages/ci/src/runner-order/machine-registry-sqlite.js";
import {
	feedProviderHealth,
	SqliteProviderHealthStore,
} from "../../../packages/ci/src/runner-order/provider-health-sqlite.js";
import {
	LedgerSpendReader,
	monthStartMs,
} from "../../../packages/ci/src/runner-order/spend.js";
import {
	InMemoryInsightStore,
	InMemoryMachineRegistry,
	InMemoryRouteFactsSource,
	InMemoryRouteJournal,
	InMemoryRunnerOrderSource,
	testMachineAdvert,
	testRelayJobMessage,
} from "../../../packages/ci/src/runner-order/testing.js";
import { HOSTED_LIST_PRICES } from "../../../packages/ci/src/runner-routing/models.js";
import {
	autoRetryRun,
	InMemoryRetryLedger,
} from "../../../packages/ci-gh-actions/src/auto-retry.js";
import { GithubMinutesReader } from "../../../packages/ci-gh-actions/src/billing-usage.js";
import {
	EpochMs,
	GhAccountId,
	GhActorId,
	GhLintSandbox,
	GhRelayApi,
	GhRelayJobId,
	GhRelayNodeId,
	GhRepoSlug,
	GhRunnerLabel,
	GhRunnerProtocol,
	NonEmptyReason,
	NonNegativeCount,
	PositiveRunId,
} from "../../../packages/ci-gh-actions/src/domain/index.js";
import { createGhRelayInMemoryLayer } from "../../../packages/ci-gh-actions/src/host/index.js";
import {
	type InsightAttemptStore,
	InsightIngest,
} from "../../../packages/ci-gh-actions/src/insight-ingest.js";
import {
	type MachineProfile,
	machineRunsOnLabel,
	registryAdvertSink,
	signedMachineAdvert,
} from "../../../packages/ci-gh-actions/src/machine-worker/advert.js";
import {
	containerExecutor,
	containerJobEnvironment,
	hostJobEnvironment,
} from "../../../packages/ci-gh-actions/src/machine-worker/executor.js";
import { githubQueueJobSource } from "../../../packages/ci-gh-actions/src/machine-worker/jobs.js";
import { FakeContainerDriver } from "../../../packages/ci-gh-actions/src/machine-worker/testing.js";
import {
	createMachineWorker,
	type MachineWorker,
} from "../../../packages/ci-gh-actions/src/machine-worker/worker.js";
import {
	READ_API_PREFIX,
	READ_API_ROUTES,
	readApiOpenApi,
} from "../../../packages/ci-gh-actions/src/read-api.js";
import { RELAY_MCP_INSIGHT_SCOPE } from "../../../packages/ci-gh-actions/src/relay-mcp-insights.js";
import type { RunnerAdoptionGithub } from "../../../packages/ci-gh-actions/src/runner-adoption.js";
import { parseJitConfig } from "../../../packages/ci-gh-actions/src/runner-protocol/jit-config.js";
import { restoreWorkflowPlan } from "../../../packages/ci-gh-actions/src/workflow-init.js";
import { GithubSimulator } from "../../../packages/ci-gh-actions/test/support/github-simulator/index.js";
import {
	type SimulatedRunnerRun,
	simulatedRunnerProgram,
	simulatorMachineGithub,
} from "../../../packages/ci-gh-actions/test/support/machine-connect-simulator.js";
import {
	readApiFixture,
	readPath,
} from "../../../packages/ci-gh-actions/test/support/read-api-fixture.js";
import {
	callTool,
	insightWorld,
	type JsonObject,
	READER,
	rpc,
} from "../../../packages/ci-gh-actions/test/support/relay-mcp-insights-world.js";
import { createHoboCli } from "../../../packages/cli/src/index.js";
import { createCiCommand } from "../../../packages/hobo/src/ci-command.js";
import { runCiInit } from "../../../packages/hobo/src/ci-init.js";
import { CI_MACHINE_COMMAND } from "../../../packages/hobo/src/ci-machine.js";
import { CI_PROVIDER_HEALTH_COMMAND } from "../../../packages/hobo/src/ci-provider-health.js";
import { runCiRoute } from "../../../packages/hobo/src/ci-route.js";
import { createCiRunnersCommand } from "../../../packages/hobo/src/ci-runners.js";
import {
	collectCodes,
	readSources,
} from "../../../scripts/ci/error-catalog.mts";
import { FakeParityDriver, PARITY_ACCOUNT } from "./driver.js";

const REPO = "octo/app";
const MINUTE = 60_000;
const T0 = 1_763_400_000_000;
const OWNER = { accountId: PARITY_ACCOUNT, ownerId: "42", ownerLogin: "octocat" };

const tick = (): Promise<void> =>
	new Promise<void>((resolveTick) => setImmediate(resolveTick));

class ParityInsightStore
	extends InMemoryInsightStore
	implements InsightAttemptStore
{
	async attempt(
		repository: string,
		id: number,
		attemptNumber: number,
	): Promise<InsightRun | undefined> {
		const all = await this.runs({
			repository,
			sinceMs: 0,
			limit: Number.MAX_SAFE_INTEGER,
		});
		return all.find((run) => run.id === id && run.attempt === attemptNumber);
	}
}

const McpToolsListSchema = z.object({
	tools: z.array(z.object({ name: z.string() })).default([]),
});

type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number(),
		z.boolean(),
		z.null(),
		z.array(JsonValueSchema),
		z.record(z.string(), JsonValueSchema),
	]),
);

const JsonRecordSchema = z.record(z.string(), JsonValueSchema);

function asJsonRecord(
	value: JsonValue | undefined,
): { readonly [key: string]: JsonValue } | undefined {
	const parsed = JsonRecordSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

function jsonField(
	value: JsonValue | undefined,
	name: string,
): JsonValue | undefined {
	const record = asJsonRecord(value);
	return record ? record[name] : undefined;
}

function resolveSchemaRef(
	root: JsonValue,
	schema: JsonValue | undefined,
): JsonValue | undefined {
	const ref = jsonField(schema, "$ref");
	if (z.string().startsWith("#/").safeParse(ref).success) {
		let target: JsonValue | undefined = root;
		for (const part of String(ref).slice(2).split("/")) {
			target = jsonField(target, part);
		}
		return target;
	}
	return schema;
}

function jsonValueKind(value: JsonValue): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (asJsonRecord(value) !== undefined) return "object";
	if (z.number().int().safeParse(value).success) return "integer";
	if (z.number().safeParse(value).success) return "number";
	if (z.boolean().safeParse(value).success) return "boolean";
	return "string";
}

function openApiViolations(
	root: JsonValue,
	value: JsonValue,
	rawSchema: JsonValue | undefined,
	at = "$",
): string[] {
	const schema = resolveSchemaRef(root, rawSchema);
	if (schema === undefined) return [`${at}: no schema`];
	const found: string[] = [];
	const expectedType = jsonField(schema, "type");
	const actual = jsonValueKind(value);
	if (
		expectedType !== undefined &&
		expectedType !== actual &&
		!(expectedType === "number" && actual === "integer")
	) {
		return [`${at}: ${actual} is not ${String(expectedType)}`];
	}
	const choices = jsonField(schema, "enum");
	if (Array.isArray(choices) && !choices.includes(value)) {
		found.push(`${at}: ${String(value)} is not one of ${choices.join(", ")}`);
	}
	const minimum = jsonField(schema, "minimum");
	if (minimum !== undefined && Number(value) < Number(minimum)) {
		found.push(`${at}: below ${String(minimum)}`);
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			found.push(
				...openApiViolations(
					root,
					item,
					jsonField(schema, "items"),
					`${at}[${index}]`,
				),
			);
		});
	} else {
		const objectValue = asJsonRecord(value);
		if (objectValue !== undefined) {
			const properties = jsonField(schema, "properties");
			const extra = jsonField(schema, "additionalProperties");
			const required = jsonField(schema, "required");
			for (const name of Array.isArray(required) ? required : []) {
				if (jsonField(objectValue, String(name)) === undefined) {
					found.push(`${at}.${String(name)}: required`);
				}
			}
			for (const [name, item] of Object.entries(objectValue)) {
				const property = jsonField(properties, name);
				if (property !== undefined) {
					found.push(...openApiViolations(root, item, property, `${at}.${name}`));
				} else if (extra === false) {
					found.push(`${at}.${name}: not allowed`);
				} else if (asJsonRecord(extra) !== undefined) {
					found.push(...openApiViolations(root, item, extra, `${at}.${name}`));
				}
			}
		}
	}
	return found;
}

type ExtendedState = {
	tempDirs: string[];
	nowMs: number;
	minutesReader: GithubMinutesReader | undefined;
	minutesUsed: number;
	minutesFail: boolean;
	minutesSkipReasons: string[];
	depotSpentMicros: bigint;
	depotLimitUsd: number;
	healthDbPath: string | undefined;
	healthStore: SqliteProviderHealthStore | undefined;
	retryLedger: InMemoryRetryLedger;
	retryCalls: number[];
	retryOutcomes: readonly boolean[];
	routeAnswer: RelayJobAnswer | undefined;
	routeDriver: FakeParityDriver;
	routeJournal: InMemoryRouteJournal;
	rerunAnswers: RelayJobAnswer[];
	github: GithubSimulator;
	registry: InMemoryMachineRegistry;
	sqliteDb: DatabaseSync | undefined;
	sqliteRegistry: SqliteMachineRegistry | undefined;
	sqliteHome: string | undefined;
	worker: MachineWorker | undefined;
	workerRuns: SimulatedRunnerRun[];
	containerDriver: FakeContainerDriver | undefined;
	takeoverEvents: string[];
	takeoverStaleRefused: boolean;
	takeoverFirstIdentity: ReturnType<typeof generateMachineIdentity> | undefined;
	adoptedLabel: string | undefined;
	adoptedRunnerCalls: Array<readonly [string, string]>;
	adoptedGithub: RunnerAdoptionGithub | undefined;
	jitRejected: boolean;
	jobEnvLeaked: boolean;
	brokenRouteOutput: string;
	brokenRouteExitCode: number;
	r11Request: Readonly<{ size: number; first: string }> | undefined;
	r14Results: readonly string[];
	m04Slots: number;
	releaseHeldJob: (() => void) | undefined;
	insightStore: ParityInsightStore;
	insightRuns: readonly InsightRun[];
	initRepoDir: string | undefined;
	initOriginalWorkflow: string;
	initBeforeHead: string;
	mcpToolNames: string[];
	mcpScope: string;
	mcpMutated: boolean;
	readApiResponses: ReadonlyMap<
		string,
		Readonly<{ status: number; body: JsonValue }>
	>;
	multiMachineAnswers: RelayJobAnswer[];
	machineId: string;
};

let ext: ExtendedState;

function makeTempDir(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix)).then((dir) => {
		ext.tempDirs.push(dir);
		return dir;
	});
}

function outputOf(answer: RelayJobAnswer | undefined, name: string): string {
	return answer?.outputs.find((item) => item.name === name)?.value ?? "";
}

async function settleWorker(worker: MachineWorker): Promise<void> {
	for (let turn = 0; turn < 400 && worker.status().running > 0; turn += 1) {
		await new Promise((resolveTurn) => setTimeout(resolveTurn, 5));
	}
}

Before({ tags: "@parity" }, () => {
	ext = {
		tempDirs: [],
		nowMs: T0,
		minutesReader: undefined,
		minutesUsed: 0,
		minutesFail: false,
		minutesSkipReasons: [],
		depotSpentMicros: 0n,
		depotLimitUsd: 50,
		healthDbPath: undefined,
		healthStore: undefined,
		retryLedger: new InMemoryRetryLedger(),
		retryCalls: [],
		retryOutcomes: [],
		routeAnswer: undefined,
		routeDriver: new FakeParityDriver(),
		routeJournal: new InMemoryRouteJournal(),
		rerunAnswers: [],
		github: new GithubSimulator(),
		registry: new InMemoryMachineRegistry(),
		sqliteDb: undefined,
		sqliteRegistry: undefined,
		sqliteHome: undefined,
		worker: undefined,
		workerRuns: [],
		containerDriver: undefined,
		takeoverEvents: [],
		takeoverStaleRefused: false,
		takeoverFirstIdentity: undefined,
		adoptedLabel: undefined,
		adoptedRunnerCalls: [],
		adoptedGithub: undefined,
		jitRejected: false,
		jobEnvLeaked: false,
		brokenRouteOutput: "",
		brokenRouteExitCode: 0,
		r11Request: undefined,
		r14Results: [],
		m04Slots: 0,
		releaseHeldJob: undefined,
		insightStore: new ParityInsightStore(),
		insightRuns: [],
		initRepoDir: undefined,
		initOriginalWorkflow: "",
		initBeforeHead: "",
		mcpToolNames: [],
		mcpScope: RELAY_MCP_INSIGHT_SCOPE,
		mcpMutated: false,
		readApiResponses: new Map(),
		multiMachineAnswers: [],
		machineId: "m-ext-1",
	};
});

After({ tags: "@parity" }, async () => {
	ext.releaseHeldJob?.();
	if (ext.worker) {
		await settleWorker(ext.worker);
	}
	ext.healthStore?.close();
	ext.sqliteDb?.close();
	for (const dir of ext.tempDirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

async function runMachineCli(args: readonly string[]): Promise<void> {
	assert.ok(ext.sqliteHome, "machine home exists");
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: {
					HOBO_HOME: ext.sqliteHome,
					HOBO_CI_ACCOUNT_ID: PARITY_ACCOUNT,
				},
				now: () => ext.nowMs,
				git: async (gitArgs) =>
					gitArgs[0] === "rev-parse"
						? (ext.sqliteHome ?? tmpdir())
						: `git@github.com:${REPO}.git`,
				commands: [CI_MACHINE_COMMAND],
			}),
		},
	});
	const result = await cli.run(["ci", ...args], { cwd: ext.sqliteHome });
	assert.equal(result.exitCode, 0, result.stdout + result.stderr);
}

export async function handleExtendedRunCommand(
	command: string,
): Promise<boolean> {
	if (command === "hobo ci machine connect") {
		ext.github.addRepository(REPO, true);
		const github = simulatorMachineGithub(ext.github);
		const { program, runs } = simulatedRunnerProgram(ext.github);
		ext.workerRuns = runs;
		const docker = new FakeContainerDriver(program);
		const worker = createMachineWorker({
			profile: {
				id: "m-connect-1",
				name: "dev-box",
				os: "linux",
				arch: "x64",
				isolation: "container",
				...OWNER,
			},
			identity: generateMachineIdentity().identity,
			sink: registryAdvertSink(ext.registry, OWNER),
			jobs: githubQueueJobSource({
				github,
				repositories: [REPO],
				label: machineRunsOnLabel("m-connect-1"),
				pollMs: 0,
			}),
			github,
			executor: containerExecutor({
				docker,
				image: "runner:test",
				arch: "x64",
				env: {},
				wait: () => tick(),
			}),
			concurrency: 1,
			sharing: "only_me",
			now: () => ext.nowMs,
			emit: () => {},
		});
		ext.worker = worker;
		await worker.tick();
		return true;
	}

	if (command === "hobo ci init --apply all") {
		assert.ok(ext.initRepoDir, "temp git repository exists");
		const result = await runCiInit({
			cwd: ext.initRepoDir,
			args: [],
			options: { apply: "all", label: "hobo" },
		});
		assert.notEqual(result.ok, false, result.message);
		return true;
	}

	return false;
}

export async function handleExtendedRunForItCommand(
	command: string,
): Promise<boolean> {
	if (command === "hobo ci machine pause") {
		await runMachineCli(["machine", "pause", ext.machineId]);
		return true;
	}
	if (command === "hobo ci machine resume") {
		await runMachineCli(["machine", "resume", ext.machineId]);
		return true;
	}
	if (command === "hobo ci machine remove") {
		await runMachineCli(["machine", "remove", ext.machineId]);
		return true;
	}
	if (command === "hobo ci runners adopt") {
		const home = await makeTempDir("hobo-parity-m10-");
		ext.sqliteHome = home;
		assert.ok(ext.adoptedGithub, "fake adoption github exists");
		const cli = createHoboCli({
			commands: {
				ci: createCiCommand({
					env: { HOBO_HOME: home, HOBO_CI_ACCOUNT_ID: PARITY_ACCOUNT },
					now: () => ext.nowMs,
					git: async (gitArgs) =>
						gitArgs[0] === "rev-parse" ? home : `git@github.com:${REPO}.git`,
					commands: [
						createCiRunnersCommand({
							openGithub: async () => ext.adoptedGithub,
						}),
					],
				}),
			},
		});
		const adopted = await cli.run(["ci", "runners", "adopt", "7", "--json"], {
			cwd: home,
		});
		assert.equal(adopted.exitCode, 0, adopted.stdout + adopted.stderr);
		const parsed: Readonly<{ data: Readonly<{ label: string }> }> = JSON.parse(
			adopted.stdout,
		);
		ext.adoptedLabel = parsed.data.label;
		return true;
	}
	return false;
}

Given(
	"the owner's measured Actions minutes are read by the billing reader",
	() => {
		ext.minutesUsed = 1_500;
		ext.minutesFail = false;
		ext.minutesReader = new GithubMinutesReader({
			fetch: async () => {
				if (ext.minutesFail) return new Response("unavailable", { status: 503 });
				return Response.json({
					usageItems: [
						{
							product: "Actions",
							sku: "Actions Linux",
							unitType: "Minutes",
							quantity: ext.minutesUsed,
							pricePerUnit: 0.006,
							grossAmount: ext.minutesUsed * 0.006,
							discountAmount: ext.minutesUsed * 0.006,
							netAmount: 0,
						},
					],
				});
			},
			baseUrl: "https://api.github.com",
			token: async () => "installation-token",
			plan: async () => "free",
			recentMinutes: undefined,
			now: () => ext.nowMs,
			cacheMs: 0,
		});
	},
);

When(
	"the minutes used pass the limit, or the burn would pass it within two hours",
	async () => {
		assert.ok(ext.minutesReader);
		const order = new InMemoryRunnerOrderSource(
			new Map([
				[
					REPO,
					JSON.stringify({
						steps: [
							{ key: "github", minutesLimitPercent: 80 },
							{ key: "depot" },
						],
					}),
				],
			]),
		);
		const msg = testRelayJobMessage({
			repository: REPO,
			inputs: [
				["github", "ubuntu-24.04"],
				["depot", "depot-ubuntu-24.04"],
			],
		});

		ext.minutesUsed = 1_700;
		const overUsage = await ext.minutesReader.usage("octo");
		const overJournal = new InMemoryRouteJournal();
		await answerRelayJob(msg, {
			order,
			facts: new InMemoryRouteFactsSource(() => ({
				...NO_ROUTE_FACTS,
				minutes: overUsage,
			})),
			journal: overJournal,
			nowMs: ext.nowMs,
			mode: "relay",
			node: "parity-node",
			accountId: PARITY_ACCOUNT,
			checks: undefined,
		});
		const overDecision = (
			await overJournal.decisions({
				accountId: PARITY_ACCOUNT,
				repository: REPO,
				sinceMs: 0,
				limit: 10,
			})
		)[0]?.decision;
		const overReason = overDecision?.skipped.find(
			(item) => item.key === "github",
		)?.reason;
		if (overReason) ext.minutesSkipReasons.push(overReason);

		const runwayReader = new GithubMinutesReader({
			fetch: async () =>
				Response.json({
					usageItems: [
						{
							product: "Actions",
							sku: "Actions Linux",
							unitType: "Minutes",
							quantity: 1_500,
							pricePerUnit: 0.006,
							grossAmount: 9,
							discountAmount: 9,
							netAmount: 0,
						},
					],
				}),
			baseUrl: "https://api.github.com",
			token: async () => "installation-token",
			plan: async () => "free",
			recentMinutes: async () => 400,
			now: () => ext.nowMs,
			cacheMs: 0,
		});
		const runwayUsage = await runwayReader.usage("octo");
		const runwayJournal = new InMemoryRouteJournal();
		await answerRelayJob(msg, {
			order,
			facts: new InMemoryRouteFactsSource(() => ({
				...NO_ROUTE_FACTS,
				minutes: runwayUsage,
			})),
			journal: runwayJournal,
			nowMs: ext.nowMs,
			mode: "relay",
			node: "parity-node",
			accountId: PARITY_ACCOUNT,
			checks: undefined,
		});
		const runwayDecision = (
			await runwayJournal.decisions({
				accountId: PARITY_ACCOUNT,
				repository: REPO,
				sinceMs: 0,
				limit: 10,
			})
		)[0]?.decision;
		const runwayReason = runwayDecision?.skipped.find(
			(item) => item.key === "github",
		)?.reason;
		if (runwayReason) ext.minutesSkipReasons.push(runwayReason);
	},
);

Then(
	"the github step is passed over with {string} or {string}",
	(first: string, second: string) => {
		assert.ok(ext.minutesSkipReasons.includes(first), `expected ${first}`);
		assert.ok(ext.minutesSkipReasons.includes(second), `expected ${second}`);
	},
);

Then(
	"when the minutes cannot be read, the github step is still used",
	async () => {
		const reader = new GithubMinutesReader({
			fetch: async () => new Response("unavailable", { status: 503 }),
			baseUrl: "https://api.github.com",
			token: async () => "installation-token",
			plan: async () => "free",
			recentMinutes: undefined,
			now: () => ext.nowMs,
			cacheMs: 0,
		});
		const unread = await reader.usage("octo");
		assert.equal(unread, undefined);
		const answer = await answerRelayJob(
			testRelayJobMessage({
				repository: REPO,
				inputs: [["github", "ubuntu-24.04"]],
			}),
			{
				order: new InMemoryRunnerOrderSource(
					new Map([
						[
							REPO,
							JSON.stringify({
								steps: [
									{ key: "github", minutesLimitPercent: 80 },
									{ key: "github" },
								],
							}),
						],
					]),
				),
				facts: new InMemoryRouteFactsSource(() => ({
					...NO_ROUTE_FACTS,
					minutes: unread,
				})),
				journal: new InMemoryRouteJournal(),
				nowMs: ext.nowMs,
				mode: "relay",
				node: "parity-node",
				accountId: PARITY_ACCOUNT,
				checks: undefined,
			},
		);
		assert.equal(outputOf(answer, "step"), "github");
	},
);

Given("the ledger holds this month's spend on depot", () => {
	ext.depotSpentMicros = 50_000_000n;
	ext.depotLimitUsd = 50;
});

When("the spend reaches the depot spend limit", async () => {
	const reader: SpendReader = new LedgerSpendReader({
		ledger: {
			accountLeases: async () => [
				create(LeaseSchema, {
					id: "lease-depot-1",
					accountId: PARITY_ACCOUNT,
					provider: "depot",
					paidMicros: Number(ext.depotSpentMicros),
					settledAt: new Date(ext.nowMs - 5 * MINUTE).toISOString(),
				}),
			],
		},
		finishedJobs: undefined,
	});
	const spentMap = await reader.spentUsd(PARITY_ACCOUNT, monthStartMs(ext.nowMs));
	const order = new InMemoryRunnerOrderSource(
		new Map([
			[
				REPO,
				JSON.stringify({
					steps: [
						{ key: "depot", spendLimitUsd: ext.depotLimitUsd },
						{ key: "github" },
					],
				}),
			],
		]),
	);
	ext.routeAnswer = await answerRelayJob(
		testRelayJobMessage({
			repository: REPO,
			inputs: [
				["depot", "depot-ubuntu-24.04"],
				["github", "ubuntu-24.04"],
			],
		}),
		{
			order,
			facts: new InMemoryRouteFactsSource(() => ({
				...NO_ROUTE_FACTS,
				spendUsd: spentMap,
			})),
			journal: ext.routeJournal,
			nowMs: ext.nowMs,
			mode: "relay",
			node: "parity-node",
			accountId: PARITY_ACCOUNT,
			checks: undefined,
		},
	);
});

Then("the depot step is passed over with {string}", async (reason: string) => {
	const events = await ext.routeJournal.decisions({
		accountId: PARITY_ACCOUNT,
		repository: REPO,
		sinceMs: 0,
		limit: 20,
	});
	const decision = events.find((event) => event.decision !== undefined)?.decision;
	assert.ok(decision, "journal holds a route decision");
	assert.ok(
		decision.skipped.some(
			(skip) => skip.key === "depot" && skip.reason === reason,
		),
		`expected depot skipped with ${reason}, got ${JSON.stringify(decision.skipped)}`,
	);
});

Then("with no ledger entry the depot step is still used", async () => {
	const emptyReader: SpendReader = new LedgerSpendReader({
		ledger: {
			accountLeases: async () => [],
		},
		finishedJobs: undefined,
	});
	const spentMap = await emptyReader.spentUsd(
		PARITY_ACCOUNT,
		monthStartMs(ext.nowMs),
	);
	assert.equal(spentMap.get("depot"), 0);
	const answer = await answerRelayJob(
		testRelayJobMessage({
			repository: REPO,
			inputs: [
				["depot", "depot-ubuntu-24.04"],
				["github", "ubuntu-24.04"],
			],
		}),
		{
			order: new InMemoryRunnerOrderSource(
				new Map([
					[
						REPO,
						JSON.stringify({
							steps: [
								{ key: "depot", spendLimitUsd: ext.depotLimitUsd },
								{ key: "github" },
							],
						}),
					],
				]),
			),
			facts: new InMemoryRouteFactsSource(() => ({
				...NO_ROUTE_FACTS,
				spendUsd: spentMap,
			})),
			journal: new InMemoryRouteJournal(),
			nowMs: ext.nowMs,
			mode: "relay",
			node: "parity-node",
			accountId: PARITY_ACCOUNT,
			checks: undefined,
		},
	);
	assert.equal(outputOf(answer, "step"), "depot");
});

Given("depot missed three jobs within thirty minutes", async () => {
	const dir = await makeTempDir("hobo-parity-r09-");
	const dbPath = join(dir, "ci", "serve", "provider-health.sqlite");
	await mkdir(join(dir, "ci", "serve"), { recursive: true });
	ext.healthDbPath = dbPath;
	ext.sqliteHome = dir;
	const store = new SqliteProviderHealthStore(dbPath);
	for (const [id, at] of [
		[1, T0],
		[2, T0 + MINUTE],
		[3, T0 + 2 * MINUTE],
	] as const) {
		await feedProviderHealth(
			store,
			create(JobFactSchema, {
				id,
				name: "test",
				labels: ["depot-ubuntu-24.04"],
				queuedAtMs: at,
			}),
			at + 11 * MINUTE,
		);
	}
	store.close();
	ext.nowMs = T0 + 13 * MINUTE;
	const reopened = new SqliteProviderHealthStore(dbPath);
	ext.healthStore = reopened;
	const unhealthy = await reopened.unhealthy(ext.nowMs);
	ext.routeAnswer = await answerRelayJob(
		testRelayJobMessage({
			repository: REPO,
			inputs: [
				["depot", "depot-ubuntu-24.04"],
				["github", "ubuntu-24.04"],
			],
		}),
		{
			order: new InMemoryRunnerOrderSource(
				new Map([
					[
						REPO,
						JSON.stringify({ steps: [{ key: "depot" }, { key: "github" }] }),
					],
				]),
			),
			facts: new InMemoryRouteFactsSource(() => ({
				...NO_ROUTE_FACTS,
				unhealthy,
			})),
			journal: ext.routeJournal,
			nowMs: ext.nowMs,
			mode: "relay",
			node: "parity-node",
			accountId: PARITY_ACCOUNT,
			checks: undefined,
		},
	);
});

Then("the health record survives a relay restart", async () => {
	assert.ok(ext.healthDbPath);
	ext.healthStore?.close();
	const restarted = new SqliteProviderHealthStore(ext.healthDbPath);
	ext.healthStore = restarted;
	const unhealthy = await restarted.unhealthy(ext.nowMs);
	assert.ok(unhealthy.has("depot:depot-ubuntu-24.04"));
});

Then("a trial job is let through after the back-off", async () => {
	assert.ok(ext.healthStore);
	const afterBackoff = T0 + 25 * MINUTE;
	const unhealthy = await ext.healthStore.unhealthy(afterBackoff);
	assert.equal(unhealthy.has("depot:depot-ubuntu-24.04"), false);
});

Then("{string} clears it", async (command: string) => {
	assert.ok(ext.sqliteHome);
	ext.healthStore?.close();
	ext.healthStore = undefined;
	const words = command.trim().split(/\s+/u).slice(1);
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: { HOBO_HOME: ext.sqliteHome },
				now: () => ext.nowMs,
				git: async () => ext.sqliteHome ?? tmpdir(),
				commands: [CI_PROVIDER_HEALTH_COMMAND],
			}),
		},
	});
	const result = await cli.run(words, { cwd: ext.sqliteHome });
	assert.equal(result.exitCode, 0, result.stdout + result.stderr);
	assert.ok(ext.healthDbPath);
	const reopened = new SqliteProviderHealthStore(ext.healthDbPath);
	ext.healthStore = reopened;
	assert.equal((await reopened.unhealthy(ext.nowMs)).size, 0);
});

Given("a job failed before its own steps ran", () => {
	ext.retryLedger = new InMemoryRetryLedger();
	ext.retryCalls = [];
	ext.retryOutcomes = [];
});

When("its workflow_run completed webhook is delivered twice", async () => {
	const order = new InMemoryRunnerOrderSource(
		new Map([
			[
				REPO,
				JSON.stringify({
					steps: [{ key: "depot" }, { key: "github" }],
					retry: { enabled: true, runner: "other", max: 2 },
				}),
			],
		]),
	);
	const journal = new InMemoryRouteJournal();
	for (const attempt of [1, 2, 3]) {
		await journal.record(
			create(RunnerRouteEventSchema, {
				type: "runner.route.Decided",
				accountId: PARITY_ACCOUNT,
				atMs: T0 + attempt * 1_000,
				mode: "relay",
				node: "parity-node",
				jobId: `relay-${attempt}`,
				request: create(RunnerRouteRequestSchema, {
					repository: REPO,
					private: true,
					event: "push",
					runId: 77n,
					runAttempt: attempt,
					job: "route",
					inputs: [
						{ key: "depot", labels: ["depot-ubuntu-24.04"] },
						{ key: "github", labels: ["ubuntu-24.04"] },
					],
				}),
				decision: {
					outcome: "routed",
					step: "depot",
					runner: "depot-ubuntu-24.04",
					reason: "Routed to depot-ubuntu-24.04 (depot).",
				},
			}),
		);
	}

	const makeRun = (attempt: number): InsightRun => ({
		id: 77,
		attempt,
		repository: REPO,
		workflow: "CI",
		workflowPath: ".github/workflows/ci.yml",
		event: "push",
		branch: "main",
		defaultBranch: "main",
		headSha: "a".repeat(40),
		actor: "octocat",
		conclusion: "failure",
		createdAtMs: T0,
		completedAtMs: T0 + 3 * MINUTE,
		jobs: [
			{
				id: 1,
				name: "route",
				labels: ["hobo-relay"],
				conclusion: "success",
				queuedAtMs: T0,
				startedAtMs: T0 + 1_000,
				completedAtMs: T0 + 2_000,
				steps: [],
				billed: false,
				relay: true,
			},
			{
				id: 500 + attempt,
				name: "test",
				labels: ["depot-ubuntu-24.04"],
				conclusion: "failure",
				queuedAtMs: T0 + 5_000,
				startedAtMs: T0 + 10_000,
				completedAtMs: T0 + 20_000,
				steps: [{ name: "Set up job", number: 1, conclusion: "failure" }],
				billed: true,
			},
		],
	});

	const deps = {
		accountId: PARITY_ACCOUNT,
		nowMs: T0 + 4 * MINUTE,
		order,
		journal,
		ledger: ext.retryLedger,
		annotations: async () => [
			"The runner has received a shutdown signal. Lost communication with the server.",
		],
		machineDisconnects: async () => [],
		rerun: async (_repo: string, jobId: number) => {
			ext.retryCalls.push(jobId);
			return { ok: true, status: 201 };
		},
	};

	const first = await autoRetryRun(makeRun(1), deps);
	const duplicate = await autoRetryRun(makeRun(1), deps);
	const secondAttempt = await autoRetryRun(makeRun(2), deps);
	const thirdAttempt = await autoRetryRun(makeRun(3), deps);
	ext.retryOutcomes = [
		first.retried,
		duplicate.retried,
		secondAttempt.retried,
		thirdAttempt.retried,
	];
});

Then("the failed jobs are re-run once", () => {
	assert.equal(ext.retryOutcomes[0], true);
	assert.equal(ext.retryOutcomes[1], false);
});

Then("no job is retried more than twice", () => {
	assert.equal(ext.retryOutcomes[2], true);
	assert.equal(ext.retryOutcomes[3], false);
	assert.equal(ext.retryCalls.length, 2);
});

Given(
	"a job asking for {string} and {string}",
	(sizeSpec: string, firstSpec: string) => {
		const size = Number.parseInt(sizeSpec.split(":")[1]?.trim() ?? "8", 10);
		const first = firstSpec.split(":")[1]?.trim() ?? "depot";
		ext.routeDriver.commitOrder(
			REPO,
			JSON.stringify({
				steps: [{ key: "machine" }, { key: "depot" }, { key: "github" }],
			}),
		);
		ext.routeAnswer = undefined;
		ext.rerunAnswers = [];
		ext.routeDriver.setFacts({
			...NO_ROUTE_FACTS,
			machines: [
				{
					id: "m-1",
					name: "dev",
					runsOn: "hobo-machine-m-1",
					labels: ["self-hosted", "Linux", "X64"],
					online: true,
					paused: false,
					slots: 1,
					busy: 0,
					sharing: "only_me",
					ownerId: "42",
					ownerCanRead: true,
					lastPickedAtMs: 0,
					repository: undefined,
				},
			],
		});
		ext.r11Request = { size, first };
	},
);

When("the relay job is answered", async () => {
	assert.ok(ext.r11Request, "R11 request parameters exist");
	ext.routeAnswer = await ext.routeDriver.answer(
		testRelayJobMessage({
			repository: REPO,
			inputs: [
				["size", String(ext.r11Request.size)],
				["first", ext.r11Request.first],
				["machine", "self-hosted"],
				["depot", "auto"],
				["github", "ubuntu-24.04"],
			],
		}),
	);
});

Then("the depot step is tried first with an 8 vCPU label", () => {
	assert.equal(ext.routeAnswer?.conclusion, "succeeded");
	assert.equal(outputOf(ext.routeAnswer, "step"), "depot");
	assert.equal(outputOf(ext.routeAnswer, "runner"), "depot-ubuntu-24.04-8");
});

Given("a run whose job on a HoBo label failed", async () => {
	ext.routeDriver.commitOrder(
		REPO,
		JSON.stringify({ steps: [{ key: "depot" }, { key: "github" }] }),
	);
	ext.routeDriver.setFacts(NO_ROUTE_FACTS);
	const first = await ext.routeDriver.answer(
		testRelayJobMessage({
			repository: REPO,
			runId: 88,
			runAttempt: 1,
			inputs: [
				["depot", "depot-ubuntu-24.04"],
				["github", "ubuntu-24.04"],
			],
		}),
	);
	ext.rerunAnswers.push(first);
});

When("the failed jobs are re-run", async () => {
	ext.routeDriver.setFacts({
		...NO_ROUTE_FACTS,
		unhealthy: new Set(["depot:depot-ubuntu-24.04"]),
	});
	const rerun = await ext.routeDriver.answer(
		testRelayJobMessage({
			repository: REPO,
			runId: 88,
			runAttempt: 2,
			inputs: [
				["depot", "depot-ubuntu-24.04"],
				["github", "ubuntu-24.04"],
			],
		}),
	);
	ext.rerunAnswers.push(rerun);
});

Then(
	"HoBo CI claims the job again and routes it with the facts of now",
	() => {
		assert.equal(ext.rerunAnswers.length, 2);
		assert.equal(outputOf(ext.rerunAnswers[0], "step"), "depot");
		assert.equal(outputOf(ext.rerunAnswers[1], "step"), "github");
	},
);

Given(
	"a workflow whose matrix job of three legs has runs-on set to a HoBo label",
	() => {
		ext.r14Results = [];
	},
);

When("HoBo CI claims each leg", async () => {
	const world = createGhRelayInMemoryLayer({
		runnerProtocol: GhRunnerProtocol.toLayer(
			Effect.succeed({
				answerJob: () => Effect.succeed({ accepted: true }),
				rerunFailedJobs: () => Effect.succeed({ triggered: true }),
			}),
		),
		lintSandbox: GhLintSandbox.toLayer(
			Effect.succeed({
				runTool: () =>
					Effect.succeed({
						passed: true,
						summary: NonEmptyReason.make("passed"),
						findingCount: NonNegativeCount.make(0),
					}),
			}),
		),
	});
	const account = GhAccountId.make(PARITY_ACCOUNT);
	const repo = GhRepoSlug.make(REPO);
	const legs = ["node-20", "node-22", "node-24"] as const;
	const results = await Effect.runPromise(
		Effect.gen(function* () {
			const client = yield* GhRelayApi.clientInProcess;
			yield* client.ConfigureGhRunnerOrder(account, {
				repository: repo,
				order: {
					steps: [
						{ key: "depot", minutesLimitPercent: null, spendLimitCents: null },
						{ key: "github", minutesLimitPercent: null, spendLimitCents: null },
					],
					skipUnhealthy: true,
					autoSizeVcpus: 4,
					retry: null,
				},
			});
			const routed: string[] = [];
			for (const leg of legs) {
				const jobId = GhRelayJobId.make(`matrix-${leg}`);
				yield* client.QueueGhRelayJob(jobId, {
					context: {
						accountId: account,
						repository: repo,
						runId: PositiveRunId.make(99),
						runAttempt: PositiveRunId.make(1),
						jobName: `test (${leg})`,
						matrixLeg: leg,
						isPrivate: true,
						isFork: false,
						actorId: GhActorId.make("42"),
						runsOn: [GhRunnerLabel.make("hobo/depot=auto/github=ubuntu-24.04")],
						candidates: [],
						first: null,
						size: null,
						checkSteps: [],
						hasNonCheckSteps: false,
						pullRequestTitle: null,
						nowMs: EpochMs.make(T0),
						claimNodeId: GhRelayNodeId.make("parity-node-1"),
					},
				});
				for (let attempt = 0; attempt < 30; attempt += 1) {
					const activity = yield* client.GhRelayActivityView.get(jobId);
					if (activity?._tag === "Routed") {
						routed.push(`${leg}:${activity.step}:${activity.runnerLabel}`);
						break;
					}
					yield* Effect.sleep("10 millis");
				}
			}
			return routed;
		}).pipe(Effect.scoped, Effect.provide(world)),
	);
	ext.r14Results = results;
});

Then("each leg runs where the runner order sends it", () => {
	assert.deepEqual(ext.r14Results, [
		"node-20:depot:depot-ubuntu-24.04-4",
		"node-22:depot:depot-ubuntu-24.04-4",
		"node-24:depot:depot-ubuntu-24.04-4",
	]);
});

Given("a clean machine with the hobo CLI and no checkout", () => {
	ext.github = new GithubSimulator();
	ext.registry = new InMemoryMachineRegistry();
});

Then(
	"the machine is advertised and takes the next relay job it fits",
	async () => {
		assert.ok(ext.worker);
		const candidates = await registryMachineCandidates(ext.registry, {
			accountId: PARITY_ACCOUNT,
			nowMs: ext.nowMs,
			readers: new Set(["42"]),
		});
		assert.equal(candidates.length, 1);
		ext.routeDriver.commitOrder(
			REPO,
			JSON.stringify({ steps: [{ key: "machine" }, { key: "github" }] }),
		);
		ext.routeDriver.setFacts({ ...NO_ROUTE_FACTS, machines: candidates });
		const answer = await ext.routeDriver.answer(
			testRelayJobMessage({
				repository: REPO,
				inputs: [
					["machine", "self-hosted"],
					["github", "ubuntu-24.04"],
				],
			}),
		);
		assert.equal(outputOf(answer, "step"), "machine");
		const targetLabel = outputOf(answer, "runner");
		ext.github.queueJob({
			repository: REPO,
			name: "build",
			labels: [targetLabel],
		});
		await ext.worker.tick();
		await settleWorker(ext.worker);
		assert.equal(ext.workerRuns.length, 1);
	},
);

When("the command is stopped", async () => {
	assert.ok(ext.worker);
	await ext.worker.drain();
	ext.nowMs += 61_000;
});

Then(
	"within 60 seconds the next decision passes over the machine",
	async () => {
		const candidates = await registryMachineCandidates(ext.registry, {
			accountId: PARITY_ACCOUNT,
			nowMs: ext.nowMs,
			readers: new Set(["42"]),
		});
		ext.routeDriver.setFacts({ ...NO_ROUTE_FACTS, machines: candidates });
		const answer = await ext.routeDriver.answer(
			testRelayJobMessage({
				repository: REPO,
				inputs: [
					["machine", "self-hosted"],
					["github", "ubuntu-24.04"],
				],
			}),
		);
		assert.equal(outputOf(answer, "step"), "github");
	},
);

Given("a connected machine", async () => {
	ext.github = new GithubSimulator();
	ext.github.addRepository(REPO, true);
	const github = simulatorMachineGithub(ext.github);
	const { program, runs } = simulatedRunnerProgram(ext.github);
	ext.workerRuns = runs;
	const docker = new FakeContainerDriver(program);
	const home = await makeTempDir("hobo-parity-m09-");
	ext.sqliteHome = home;
	await mkdir(join(home, "ci"), { recursive: true });
	const db = new DatabaseSync(join(home, "ci", "machines.sqlite"));
	ext.sqliteDb = db;
	const sqliteRegistry = new SqliteMachineRegistry(db);
	ext.sqliteRegistry = sqliteRegistry;
	await sqliteRegistry.put(
		testMachineAdvert({
			id: ext.machineId,
			accountId: PARITY_ACCOUNT,
			runsOn: machineRunsOnLabel(ext.machineId),
			labels: ["self-hosted", "Linux", "X64"],
			lastSeenMs: ext.nowMs,
		}),
	);
	const worker = createMachineWorker({
		profile: {
			id: ext.machineId,
			name: "ephemeral-box",
			os: "linux",
			arch: "x64",
			isolation: "container",
			...OWNER,
		},
		identity: generateMachineIdentity().identity,
		sink: registryAdvertSink(ext.registry, OWNER),
		jobs: githubQueueJobSource({
			github,
			repositories: [REPO],
			label: machineRunsOnLabel(ext.machineId),
			pollMs: 0,
		}),
		github,
		executor: containerExecutor({
			docker,
			image: "runner:test",
			arch: "x64",
			env: {},
			wait: () => tick(),
		}),
		concurrency: 1,
		sharing: "only_me",
		now: () => ext.nowMs,
		emit: () => {},
	});
	ext.worker = worker;
	await worker.tick();
});

When("two jobs run on it one after the other", async () => {
	assert.ok(ext.worker);
	const label = machineRunsOnLabel(ext.machineId);
	ext.github.queueJob({ repository: REPO, name: "job-1", labels: [label] });
	await ext.worker.tick();
	await settleWorker(ext.worker);
	ext.github.queueJob({ repository: REPO, name: "job-2", labels: [label] });
	await ext.worker.tick();
	await settleWorker(ext.worker);
});

Then("each ran on its own one-job runner", () => {
	assert.equal(ext.workerRuns.length, 2);
	assert.notEqual(ext.workerRuns[0]?.runner, ext.workerRuns[1]?.runner);
});

Then("no runner stays registered once both are done", () => {
	assert.deepEqual(ext.github.runners(), []);
});

Given("a connected machine with {int} slots", async (slots: number) => {
	ext.multiMachineAnswers = [];
	ext.m04Slots = slots;
	ext.github = new GithubSimulator();
	ext.github.addRepository(REPO, true);
	ext.registry = new InMemoryMachineRegistry();
	const github = simulatorMachineGithub(ext.github);
	let releaseAll = () => {};
	const gate = new Promise<void>((resolveGate) => {
		releaseAll = resolveGate;
	});
	ext.releaseHeldJob = releaseAll;
	const { program, runs } = simulatedRunnerProgram(ext.github, {
		hold: () => gate,
	});
	ext.workerRuns = runs;
	const docker = new FakeContainerDriver(program);
	const worker = createMachineWorker({
		profile: {
			id: "m-slots",
			name: "slots-box",
			os: "linux",
			arch: "x64",
			isolation: "container",
			...OWNER,
		},
		identity: generateMachineIdentity().identity,
		sink: registryAdvertSink(ext.registry, OWNER),
		jobs: githubQueueJobSource({
			github,
			repositories: [REPO],
			label: machineRunsOnLabel("m-slots"),
			pollMs: 0,
		}),
		github,
		executor: containerExecutor({
			docker,
			image: "runner:test",
			arch: "x64",
			env: {},
			wait: () => tick(),
		}),
		concurrency: slots,
		sharing: "only_me",
		now: () => ext.nowMs,
		emit: () => {},
	});
	ext.worker = worker;
	await worker.tick();
	ext.routeDriver.commitOrder(
		REPO,
		JSON.stringify({ steps: [{ key: "machine" }, { key: "github" }] }),
	);
});

When("three relay jobs that fit it are answered", async () => {
	assert.ok(ext.worker);
	for (let index = 0; index < 3; index += 1) {
		const candidates = await registryMachineCandidates(ext.registry, {
			accountId: PARITY_ACCOUNT,
			nowMs: ext.nowMs,
			readers: new Set(["42"]),
		});
		ext.routeDriver.setFacts({ ...NO_ROUTE_FACTS, machines: candidates });
		const answer = await ext.routeDriver.answer(
			testRelayJobMessage({
				jobId: `slot-job-${index}`,
				repository: REPO,
				actorId: "42",
				triggeringActorId: "42",
				inputs: [
					["machine", "self-hosted"],
					["github", "ubuntu-24.04"],
				],
			}),
		);
		ext.multiMachineAnswers.push(answer);
		if (outputOf(answer, "step") === "machine") {
			ext.github.queueJob({
				repository: REPO,
				name: `slot-work-${index}`,
				labels: [outputOf(answer, "runner")],
			});
			ext.nowMs += 100;
			await ext.worker.tick();
			for (let waitTurn = 0; waitTurn < 50; waitTurn += 1) {
				if (ext.worker.status().running >= index + 1) break;
				await tick();
			}
			ext.nowMs += 100;
			await ext.worker.tick();
		}
	}
	ext.releaseHeldJob?.();
	await settleWorker(ext.worker);
});

Then("two route to the machine and the third does not", () => {
	const steps = ext.multiMachineAnswers.map((answer) =>
		outputOf(answer, "step"),
	);
	assert.deepEqual(steps, ["machine", "machine", "github"]);
	assert.equal(ext.workerRuns.length, ext.m04Slots);
});

Given("a connected machine running one job", async () => {
	const home = await makeTempDir("hobo-parity-m05-");
	ext.sqliteHome = home;
	await mkdir(join(home, "ci"), { recursive: true });
	const db = new DatabaseSync(join(home, "ci", "machines.sqlite"));
	ext.sqliteDb = db;
	const sqliteRegistry = new SqliteMachineRegistry(db);
	ext.sqliteRegistry = sqliteRegistry;
	ext.github = new GithubSimulator();
	ext.github.addRepository(REPO, true);
	const github = simulatorMachineGithub(ext.github);
	let releaseJob = () => {};
	const gate = new Promise<void>((resolveGate) => {
		releaseJob = resolveGate;
	});
	ext.releaseHeldJob = releaseJob;
	const { program, runs } = simulatedRunnerProgram(ext.github, {
		hold: () => gate,
	});
	ext.workerRuns = runs;
	const docker = new FakeContainerDriver(program);
	const worker = createMachineWorker({
		profile: {
			id: ext.machineId,
			name: "pause-box",
			os: "linux",
			arch: "x64",
			isolation: "container",
			...OWNER,
		},
		identity: generateMachineIdentity().identity,
		sink: registryAdvertSink(sqliteRegistry, OWNER),
		jobs: githubQueueJobSource({
			github,
			repositories: [REPO],
			label: machineRunsOnLabel(ext.machineId),
			pollMs: 0,
		}),
		github,
		executor: containerExecutor({
			docker,
			image: "runner:test",
			arch: "x64",
			env: {},
			wait: () => tick(),
		}),
		concurrency: 2,
		sharing: "only_me",
		now: () => ext.nowMs,
		emit: () => {},
	});
	ext.worker = worker;
	await worker.tick();
	ext.github.queueJob({
		repository: REPO,
		name: "in-flight-job",
		labels: [machineRunsOnLabel(ext.machineId)],
	});
	ext.nowMs += 100;
	await worker.tick();
	for (let waitTurn = 0; waitTurn < 100 && runs.length === 0; waitTurn += 1) {
		await tick();
	}
	assert.equal(worker.status().running, 1);
	ext.nowMs += 100;
	await worker.tick();
});

Then(
	"the next decision passes over it with {string}",
	async (reason: string) => {
		assert.ok(ext.sqliteRegistry);
		const candidates = await registryMachineCandidates(ext.sqliteRegistry, {
			accountId: PARITY_ACCOUNT,
			nowMs: ext.nowMs,
			readers: new Set(["42"]),
		});
		ext.routeDriver.commitOrder(
			REPO,
			JSON.stringify({ steps: [{ key: "machine" }, { key: "github" }] }),
		);
		ext.routeDriver.setFacts({ ...NO_ROUTE_FACTS, machines: candidates });
		await ext.routeDriver.answer(
			testRelayJobMessage({
				repository: REPO,
				actorId: "42",
				triggeringActorId: "42",
				inputs: [
					["machine", "self-hosted"],
					["github", "ubuntu-24.04"],
				],
			}),
		);
		const decision = (await ext.routeDriver.journal()).find(
			(event) => event.decision !== undefined,
		)?.decision;
		assert.ok(
			decision?.skipped.some(
				(skip) => skip.key === "machine" && skip.reason === reason,
			),
			`expected machine skipped with ${reason}, got ${JSON.stringify(decision?.skipped)}`,
		);
	},
);

Then("its running job finishes", async () => {
	assert.ok(ext.worker);
	assert.ok(ext.releaseHeldJob);
	assert.equal(ext.worker.status().running, 1);
	ext.releaseHeldJob();
	await settleWorker(ext.worker);
	ext.nowMs += 100;
	await ext.worker.tick();
	assert.equal(ext.worker.status().running, 0);
	assert.equal(ext.workerRuns[0]?.finished, true);
});

Then("the next relay job that fits routes to it", async () => {
	assert.ok(ext.sqliteRegistry);
	const candidates = await registryMachineCandidates(ext.sqliteRegistry, {
		accountId: PARITY_ACCOUNT,
		nowMs: ext.nowMs,
		readers: new Set(["42"]),
	});
	ext.routeDriver.setFacts({ ...NO_ROUTE_FACTS, machines: candidates });
	const answer = await ext.routeDriver.answer(
		testRelayJobMessage({
			repository: REPO,
			actorId: "42",
			triggeringActorId: "42",
			inputs: [
				["machine", "self-hosted"],
				["github", "ubuntu-24.04"],
			],
		}),
	);
	assert.equal(outputOf(answer, "step"), "machine");
	assert.equal(outputOf(answer, "runner"), machineRunsOnLabel(ext.machineId));
});

Given("a machine shared with {string}", (sharing: string) => {
	assert.equal(sharing, "anyone");
	ext.routeDriver.commitOrder(
		"octo/secret-team",
		JSON.stringify({ steps: [{ key: "machine" }, { key: "github" }] }),
	);
});

When(
	"a relay job from another member's repository the owner cannot read is answered",
	async () => {
		ext.routeDriver.setFacts({
			...NO_ROUTE_FACTS,
			machines: [
				{
					id: "m-shared",
					name: "shared-box",
					runsOn: "hobo-machine-m-shared",
					labels: ["self-hosted", "Linux", "X64"],
					online: true,
					paused: false,
					slots: 1,
					busy: 0,
					sharing: "anyone",
					ownerId: "42",
					ownerCanRead: false,
					lastPickedAtMs: 0,
					repository: undefined,
				},
			],
		});
		await ext.routeDriver.answer(
			testRelayJobMessage({
				repository: "octo/secret-team",
				actorId: "99",
				inputs: [
					["machine", "self-hosted"],
					["github", "ubuntu-24.04"],
				],
			}),
		);
	},
);

Then(
	"the decision passes over the machine with {string}",
	async (reason: string) => {
		const decision = (await ext.routeDriver.journal()).find(
			(event) => event.decision !== undefined,
		)?.decision;
		assert.ok(
			decision?.skipped.some(
				(skip) => skip.key === "machine" && skip.reason === reason,
			),
			`expected machine skipped with ${reason}, got ${JSON.stringify(decision?.skipped)}`,
		);
	},
);

Given("a connected Linux machine with default settings", () => {
	ext.containerDriver = new FakeContainerDriver(async () => 0);
});

When("a job runs on it", async () => {
	assert.ok(ext.containerDriver);
	const executor = containerExecutor({
		docker: ext.containerDriver,
		image: "hobo-runner:latest",
		arch: "x64",
		env: {},
		wait: () => tick(),
	});
	const outcome = await executor.run({
		name: "hobo-job-1",
		encodedJitConfig: "encoded-jit-1",
		signal: new AbortController().signal,
	});
	assert.equal(outcome.exitCode, 0);
});

Then("the job ran in a container started for it and removed after it", () => {
	assert.ok(ext.containerDriver);
	assert.equal(ext.containerDriver.containers.length, 1);
	const container = ext.containerDriver.containers[0];
	assert.equal(container?.started, true);
	assert.equal(container?.removed, true);
});

const TAKEOVER_PROFILE: MachineProfile = {
	id: "m-takeover-1",
	name: "takeover-box",
	os: "linux",
	arch: "x64",
	isolation: "container",
	...OWNER,
};

Given("a connected machine with its advert key", async () => {
	ext.registry = new InMemoryMachineRegistry();
	const first = generateMachineIdentity();
	ext.takeoverFirstIdentity = first;
	const sink = registryAdvertSink(ext.registry, OWNER);
	const advertA = signedMachineAdvert(
		TAKEOVER_PROFILE,
		{
			slots: 1,
			busy: 0,
			paused: false,
			sharing: "only_me",
			lastPickedAtMs: 0,
			nowMs: T0,
		},
		first.identity,
	);
	const verdict = await sink.advertise(advertA, T0);
	assert.equal(verdict.kind, "accepted");
});

When("another connect claims the same machine", async () => {
	assert.ok(ext.takeoverFirstIdentity);
	const sink = registryAdvertSink(ext.registry, OWNER);
	const second = generateMachineIdentity();
	const advertB = signedMachineAdvert(
		TAKEOVER_PROFILE,
		{
			slots: 1,
			busy: 0,
			paused: false,
			sharing: "only_me",
			lastPickedAtMs: 0,
			nowMs: T0 + 1_000,
		},
		second.identity,
	);
	const takeover = await sink.advertise(advertB, T0 + 1_000);
	assert.equal(takeover.kind, "refused");
	for (const event of takeover.events) {
		ext.takeoverEvents.push(event.type);
	}
	await removeMachine(ext.registry, {
		accountId: PARITY_ACCOUNT,
		id: TAKEOVER_PROFILE.id,
		by: OWNER.ownerLogin,
		nowMs: T0 + 1_500,
	});
	const rekeyed = await sink.advertise(
		signedMachineAdvert(
			TAKEOVER_PROFILE,
			{
				slots: 1,
				busy: 0,
				paused: false,
				sharing: "only_me",
				lastPickedAtMs: 0,
				nowMs: T0 + 2_000,
			},
			second.identity,
		),
		T0 + 2_000,
	);
	assert.equal(rekeyed.kind, "accepted");
	const staleAdvert = signedMachineAdvert(
		TAKEOVER_PROFILE,
		{
			slots: 1,
			busy: 0,
			paused: false,
			sharing: "only_me",
			lastPickedAtMs: 0,
			nowMs: T0 + 3_000,
		},
		ext.takeoverFirstIdentity.identity,
	);
	const refused = await sink.advertise(staleAdvert, T0 + 3_000);
	ext.takeoverStaleRefused = refused.kind === "refused";
});

Then("a {string} event is sent", (eventName: string) => {
	assert.ok(ext.takeoverEvents.includes(eventName));
});

Then("adverts signed with the old key are refused", () => {
	assert.equal(ext.takeoverStaleRefused, true);
});

Then("the next decision does not consider it", async () => {
	assert.ok(ext.sqliteRegistry);
	const candidates = await registryMachineCandidates(ext.sqliteRegistry, {
		accountId: PARITY_ACCOUNT,
		nowMs: ext.nowMs,
		readers: new Set(["42"]),
	});
	assert.equal(candidates.length, 0);
	ext.routeDriver.commitOrder(
		REPO,
		JSON.stringify({ steps: [{ key: "machine" }, { key: "github" }] }),
	);
	ext.routeDriver.setFacts({ ...NO_ROUTE_FACTS, machines: candidates });
	const answer = await ext.routeDriver.answer(
		testRelayJobMessage({
			repository: REPO,
			inputs: [
				["machine", "self-hosted"],
				["github", "ubuntu-24.04"],
			],
		}),
	);
	assert.equal(outputOf(answer, "step"), "github");
});

Given("a self-hosted runner already registered on the organisation", () => {
	let labels = [
		{ name: "self-hosted" },
		{ name: "Linux" },
		{ name: "X64" },
		{ name: "gpu" },
	];
	ext.adoptedRunnerCalls = [];
	ext.adoptedGithub = {
		async request(method, path, body) {
			ext.adoptedRunnerCalls.push([method, path]);
			if (method === "GET" && path === `/repos/${REPO}`) {
				return Response.json({
					private: true,
					owner: { login: "octo", type: "Organization" },
				});
			}
			if (
				method === "GET" &&
				path.startsWith(`/repos/${REPO}/actions/runners`)
			) {
				return Response.json({ runners: [] });
			}
			if (
				method === "GET" &&
				path.startsWith("/orgs/octo/actions/runner-groups")
			) {
				return Response.json({ runner_groups: [{ id: 1 }] });
			}
			if (method === "GET" && path.startsWith("/orgs/octo/actions/runners")) {
				return Response.json({
					runners: [
						{
							id: 7,
							name: "org-gpu-1",
							os: "Linux",
							status: "online",
							busy: false,
							runner_group_id: 1,
							labels,
						},
					],
				});
			}
			if (method === "GET" && path === "/user") {
				return Response.json({ id: 42, login: "octocat" });
			}
			if (method === "POST" && path === "/orgs/octo/actions/runners/7/labels") {
				for (const name of body?.labels ?? []) {
					if (!labels.some((item) => item.name === name)) {
						labels = [...labels, { name }];
					}
				}
				return Response.json({ labels });
			}
			return new Response("not found", { status: 404 });
		},
	};
});

Then("the runner gets one unique label through the runner-labels API", () => {
	assert.match(ext.adoptedLabel ?? "", /^hobo-runner-[0-9a-f]{8}$/u);
	assert.ok(
		ext.adoptedRunnerCalls.some(
			([method, path]) =>
				method === "POST" && path === "/orgs/octo/actions/runners/7/labels",
		),
	);
});

Then("the next relay job that names it routes to that label", async () => {
	assert.ok(ext.sqliteHome);
	assert.ok(ext.adoptedLabel);
	const db = new DatabaseSync(join(ext.sqliteHome, "ci", "machines.sqlite"));
	try {
		const registry = new SqliteMachineRegistry(db);
		const candidates = await registryMachineCandidates(registry, {
			accountId: PARITY_ACCOUNT,
			nowMs: ext.nowMs,
			readers: new Set(["42"]),
		});
		ext.routeDriver.commitOrder(
			REPO,
			JSON.stringify({ steps: [{ key: "machine" }, { key: "github" }] }),
		);
		ext.routeDriver.setFacts({ ...NO_ROUTE_FACTS, machines: candidates });
		const answer = await ext.routeDriver.answer(
			testRelayJobMessage({
				repository: REPO,
				inputs: [
					["machine", "self-hosted, gpu"],
					["github", "ubuntu-24.04"],
				],
			}),
		);
		assert.equal(outputOf(answer, "step"), "machine");
		assert.equal(outputOf(answer, "runner"), ext.adoptedLabel);
	} finally {
		db.close();
	}
});

Given("a one-job runner configuration for a connected machine", () => {
	try {
		parseJitConfig("not-base64-jit-config");
		ext.jitRejected = false;
	} catch {
		ext.jitRejected = true;
	}
	const cliEnv: NodeJS.ProcessEnv = {
		PATH: "/usr/bin:/bin",
		HOBO_CI_ACCOUNT_TOKEN: "secret-should-not-leak",
		INFISICAL_TOKEN: "secret-should-not-leak-2",
		GITHUB_TOKEN: "secret-should-not-leak-3",
	};
	const containerEnv = containerJobEnvironment(cliEnv, "x64");
	const hostEnv = hostJobEnvironment(cliEnv, "encoded-jit-sample");
	ext.jobEnvLeaked =
		containerEnv.has("HOBO_CI_ACCOUNT_TOKEN") ||
		containerEnv.has("INFISICAL_TOKEN") ||
		containerEnv.has("GITHUB_TOKEN") ||
		hostEnv.HOBO_CI_ACCOUNT_TOKEN !== undefined ||
		hostEnv.INFISICAL_TOKEN !== undefined ||
		hostEnv.GITHUB_TOKEN !== undefined;
});

Then(
	"a configuration that fails its check is refused before the runner starts",
	() => {
		assert.equal(ext.jitRejected, true);
	},
);

Then("the job's environment holds none of the CLI's tokens", () => {
	assert.equal(ext.jobEnvLeaked, false);
});

Then(
	"every hosted provider in the runner order has a financial model",
	() => {
		for (const provider of HOSTED_RUNNER_PROVIDERS) {
			assert.ok(
				HOSTED_LIST_PRICES.has(provider),
				`missing financial model for ${provider}`,
			);
		}
	},
);

Then("each price names its source page and the day it was read", () => {
	assert.ok(HOSTED_LIST_PRICES.size > 0);
	for (const [key, price] of HOSTED_LIST_PRICES) {
		assert.match(price.source, /^https:\/\//u, `${key} has source URL`);
		assert.match(
			price.observedAt,
			/^\d{4}-\d{2}-\d{2}/u,
			`${key} has observedAt date`,
		);
	}
});

Given("{string} holds a runnerOrder with no steps", async (file: string) => {
	const dir = await makeTempDir("hobo-parity-c03-");
	ext.initRepoDir = dir;
	const target = join(dir, file);
	await mkdir(join(target, ".."), { recursive: true });
	await writeFile(target, JSON.stringify({ runnerOrder: { steps: [] } }));
});

When("{string} runs in that checkout", async (_command: string) => {
	assert.ok(ext.initRepoDir);
	const result = await runCiRoute({
		cwd: ext.initRepoDir,
		repository: REPO,
		options: { github: "ubuntu-24.04" },
	});
	ext.brokenRouteExitCode = result.ok === false ? 1 : 0;
	ext.brokenRouteOutput = result.message ?? "";
});

Then("it is refused with the parser's sentence", () => {
	assert.notEqual(ext.brokenRouteExitCode, 0);
	assert.match(ext.brokenRouteOutput, /step|runnerOrder/iu);
});

Given(
	"run and job webhooks for a run that timed out and one that was superseded",
	async () => {
		ext.insightStore = new ParityInsightStore();
		const ingest = new InsightIngest(ext.insightStore);
		const repoObj = { full_name: REPO, default_branch: "main", private: true };
		const timedOutRun = {
			action: "completed",
			repository: repoObj,
			workflow_run: {
				id: 1001,
				run_attempt: 1,
				name: "CI",
				path: ".github/workflows/ci.yml",
				event: "pull_request",
				head_branch: "feat/a",
				head_sha: "1".repeat(40),
				actor: { login: "octocat" },
				status: "completed",
				conclusion: "timed_out",
				created_at: new Date(T0).toISOString(),
				updated_at: new Date(T0 + 360 * MINUTE).toISOString(),
			},
		};
		const timedOutJob = {
			action: "completed",
			repository: repoObj,
			workflow_job: {
				id: 2001,
				run_id: 1001,
				run_attempt: 1,
				workflow_name: "CI",
				name: "build",
				head_sha: "1".repeat(40),
				runner_name: "GitHub Actions 1",
				labels: ["ubuntu-24.04"],
				conclusion: "timed_out",
				created_at: new Date(T0).toISOString(),
				started_at: new Date(T0 + 10_000).toISOString(),
				completed_at: new Date(T0 + 360 * MINUTE).toISOString(),
				steps: [
					{
						name: "Checkout",
						number: 1,
						conclusion: "success",
						started_at: new Date(T0 + 10_000).toISOString(),
						completed_at: new Date(T0 + 25_000).toISOString(),
					},
					{
						name: "Test",
						number: 2,
						conclusion: "timed_out",
						started_at: new Date(T0 + 25_000).toISOString(),
						completed_at: new Date(T0 + 360 * MINUTE).toISOString(),
					},
				],
			},
		};
		const supersededRun = {
			action: "completed",
			repository: repoObj,
			workflow_run: {
				id: 1002,
				run_attempt: 1,
				name: "CI",
				path: ".github/workflows/ci.yml",
				event: "pull_request",
				head_branch: "feat/a",
				head_sha: "2".repeat(40),
				actor: { login: "octocat" },
				status: "completed",
				conclusion: "success",
				created_at: new Date(T0 + 1 * MINUTE).toISOString(),
				updated_at: new Date(T0 + 12 * MINUTE).toISOString(),
			},
		};
		const supersededJob = {
			action: "completed",
			repository: repoObj,
			workflow_job: {
				id: 2002,
				run_id: 1002,
				run_attempt: 1,
				workflow_name: "CI",
				name: "build",
				head_sha: "2".repeat(40),
				runner_name: "GitHub Actions 2",
				labels: ["ubuntu-24.04"],
				conclusion: "success",
				created_at: new Date(T0 + 1 * MINUTE).toISOString(),
				started_at: new Date(T0 + 2 * MINUTE).toISOString(),
				completed_at: new Date(T0 + 12 * MINUTE).toISOString(),
				steps: [
					{
						name: "Test",
						number: 1,
						conclusion: "success",
						started_at: new Date(T0 + 2 * MINUTE).toISOString(),
						completed_at: new Date(T0 + 12 * MINUTE).toISOString(),
					},
				],
			},
		};
		const newerRun = {
			action: "completed",
			repository: repoObj,
			workflow_run: {
				id: 1003,
				run_attempt: 1,
				name: "CI",
				path: ".github/workflows/ci.yml",
				event: "pull_request",
				head_branch: "feat/a",
				head_sha: "3".repeat(40),
				actor: { login: "octocat" },
				status: "completed",
				conclusion: "success",
				created_at: new Date(T0 + 3 * MINUTE).toISOString(),
				updated_at: new Date(T0 + 5 * MINUTE).toISOString(),
			},
		};
		await ingest.deliver("workflow_run", JSON.stringify(timedOutRun));
		await ingest.deliver("workflow_job", JSON.stringify(timedOutJob));
		await ingest.deliver("workflow_run", JSON.stringify(supersededRun));
		await ingest.deliver("workflow_job", JSON.stringify(supersededJob));
		await ingest.deliver("workflow_run", JSON.stringify(newerRun));
	},
);

When("the run history is read from the journal", async () => {
	ext.insightRuns = await ext.insightStore.runs({
		repository: REPO,
		sinceMs: T0 - MINUTE,
		limit: 50,
	});
});

Then("each job shows its step timings", () => {
	const timedOut = ext.insightRuns.find((entry) => entry.id === 1001);
	assert.ok(timedOut);
	assert.equal(timedOut.jobs.length, 1);
	const job = timedOut.jobs[0];
	assert.ok(job);
	assert.equal(job.steps.length, 2);
	assert.ok(
		job.steps[0]?.startedAtMs !== undefined &&
			job.steps[0]?.completedAtMs !== undefined &&
			job.steps[0].completedAtMs > job.steps[0].startedAtMs,
	);
});

Then("the timed-out and superseded runs are marked", () => {
	const timedOut = ext.insightRuns.find((entry) => entry.id === 1001);
	assert.equal(timedOut?.conclusion, "timed_out");
	const report = ciSignals(ext.insightRuns, { minMinutes: 0 });
	const superseded = report.signals.find(
		(signal) => signal.id === "no-concurrency",
	);
	assert.ok(superseded && superseded.minutes > 0, "superseded run detected");
});

Given("a repository with one workflow", async () => {
	const dir = await makeTempDir("hobo-parity-s03-");
	ext.initRepoDir = dir;
	await mkdir(join(dir, ".github", "workflows"), { recursive: true });
	const workflow = [
		"name: CI",
		"on: [push, pull_request]",
		"jobs:",
		"  test:",
		"    runs-on: ubuntu-24.04",
		"    steps:",
		"      - uses: actions/checkout@v4",
		"      - run: pnpm test",
		"",
	].join("\n");
	ext.initOriginalWorkflow = workflow;
	await writeFile(join(dir, ".github", "workflows", "ci.yml"), workflow);
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd: dir,
	});
	execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	ext.initBeforeHead = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: dir,
		encoding: "utf8",
	}).trim();
});

Then(
	"each moved job's runs-on is a HoBo label and no job is added",
	async () => {
		assert.ok(ext.initRepoDir);
		const after = await readFile(
			join(ext.initRepoDir, ".github", "workflows", "ci.yml"),
			"utf8",
		);
		assert.match(after, /runs-on:\s*hobo\s+# was ubuntu-24\.04/u);
		const jobHeaders = after.match(/^  [a-z0-9_-]+:/gmu) ?? [];
		assert.deepEqual(jobHeaders, ["  test:"]);
	},
);

Then("it makes no commit", () => {
	assert.ok(ext.initRepoDir);
	const afterHead = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: ext.initRepoDir,
		encoding: "utf8",
	}).trim();
	assert.equal(afterHead, ext.initBeforeHead);
});

When("the relay's MCP tools are listed", async () => {
	const world = await insightWorld();
	const listed = await rpc(
		world.services,
		{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
		READER,
	);
	const parsed = McpToolsListSchema.parse(listed.result);
	ext.mcpToolNames = parsed.tools.map((tool) => tool.name);
});

Then(
	"they include get_runner_order, explain_route, list_route_decisions, get_signals, get_job_times and get_run_failures",
	() => {
		for (const required of [
			"get_runner_order",
			"explain_route",
			"list_route_decisions",
			"get_signals",
			"get_job_times",
			"get_run_failures",
		]) {
			assert.ok(
				ext.mcpToolNames.includes(required),
				`missing MCP tool ${required}`,
			);
		}
	},
);

Then("the repository ships three hobo ci skills", () => {
	const root = resolve(process.cwd());
	for (const skill of ["hobo-ci", "hobo-ci-insights", "hobo-ci-route-jobs"]) {
		assert.equal(
			existsSync(join(root, ".agents", "skills", skill, "SKILL.md")),
			true,
			`missing .agents/skills/${skill}/SKILL.md`,
		);
		assert.equal(
			existsSync(join(root, ".claude", "skills", skill, "SKILL.md")),
			true,
			`missing .claude/skills/${skill}/SKILL.md`,
		);
	}
});

Then("one setup guide an agent can follow from a single prompt", () => {
	const guidePath = resolve(process.cwd(), "docs", "ci", "setup-guide.md");
	assert.equal(existsSync(guidePath), true, "missing docs/ci/setup-guide.md");
	const content = readFileSync(guidePath, "utf8");
	assert.match(content, /hobo ci connect/u);
	assert.match(content, /hobo ci init/u);
});

function concreteReadPath(routePath: string): string {
	const filled = routePath
		.replace("{id}", "102")
		.replace("{attempt}", "1");
	const query = routePath === "/runner-order" ? "?repository=octo/app" : "";
	return `${READ_API_PREFIX}${filled}${query}`;
}

When("each read API path is called with a read token", async () => {
	const fixture = await readApiFixture();
	const responses = new Map<
		string,
		Readonly<{ status: number; body: JsonValue }>
	>();
	for (const route of READ_API_ROUTES) {
		const response = await readPath(fixture, concreteReadPath(route.path));
		responses.set(route.path, {
			status: response.status,
			body: JsonValueSchema.parse(await response.json()),
		});
	}
	ext.readApiResponses = responses;
});

Then("every response matches the OpenAPI description", () => {
	const openApiText = readApiOpenApi();
	const openApiDoc = JsonValueSchema.parse(JSON.parse(openApiText));
	const checkedIn = readFileSync(
		resolve(
			process.cwd(),
			"packages",
			"ci-gh-actions",
			"schema",
			"read-api.openapi.json",
		),
		"utf8",
	);
	assert.equal(checkedIn.trim(), openApiText.trim());
	for (const route of READ_API_ROUTES) {
		const openApiPath = `${READ_API_PREFIX}${route.path}`;
		let responseSchema: JsonValue | undefined = jsonField(openApiDoc, "paths");
		for (const part of [
			openApiPath,
			"get",
			"responses",
			"200",
			"content",
			"application/json",
			"schema",
		]) {
			responseSchema = jsonField(responseSchema, part);
		}
		assert.ok(responseSchema, `OpenAPI missing schema for ${openApiPath}`);
		const seen = ext.readApiResponses.get(route.path);
		assert.ok(seen, `no response recorded for ${route.path}`);
		assert.equal(seen.status, 200, `${route.path} status`);
		assert.deepEqual(
			openApiViolations(openApiDoc, seen.body, responseSchema),
			[],
			`OpenAPI schema mismatch on ${route.path}`,
		);
	}
});

Then(
	"every HOBO_CI error code appears once on the generated error page",
	() => {
		const root = resolve(process.cwd());
		const sources = readSources(root);
		const entries = collectCodes(sources);
		const page = readFileSync(join(root, "docs", "ci", "errors.md"), "utf8");
		assert.ok(entries.length > 0);
		for (const entry of entries) {
			const occurrences = page.split(`\`${entry.code}\``).length - 1;
			assert.equal(
				occurrences,
				1,
				`expected ${entry.code} once in docs/ci/errors.md, found ${occurrences}`,
			);
		}
	},
);

Given("a repository set up by {string}", async (command: string) => {
	assert.equal(command, "hobo ci init --apply all");
	const dir = await makeTempDir("hobo-parity-s09-");
	ext.initRepoDir = dir;
	await mkdir(join(dir, ".github", "workflows"), { recursive: true });
	const workflow = [
		"name: CI",
		"on: push",
		"jobs:",
		"  build:",
		"    runs-on: ubuntu-24.04",
		"    steps:",
		"      - run: pnpm build",
		"",
	].join("\n");
	ext.initOriginalWorkflow = workflow;
	await writeFile(join(dir, ".github", "workflows", "ci.yml"), workflow);
	const applied = await runCiInit({
		cwd: dir,
		args: [],
		options: { apply: "all", label: "hobo" },
	});
	assert.notEqual(applied.ok, false, applied.message);
});

When(
	"each moved job's label is restored from its {string} comment",
	async (_marker: string) => {
		assert.ok(ext.initRepoDir);
		const workflowPath = join(
			ext.initRepoDir,
			".github",
			"workflows",
			"ci.yml",
		);
		const modified = await readFile(workflowPath, "utf8");
		const restored = restoreWorkflowPlan(modified);
		assert.ok(restored.restored > 0);
		await writeFile(workflowPath, restored.source);
	},
);

Then("the repository's workflows are as they were before", async () => {
	assert.ok(ext.initRepoDir);
	const current = await readFile(
		join(ext.initRepoDir, ".github", "workflows", "ci.yml"),
		"utf8",
	);
	assert.equal(current, ext.initOriginalWorkflow);
	assert.equal(
		existsSync(resolve(process.cwd(), "docs", "ci", "remove.md")),
		true,
	);
});

Given("a token with only the read scope", () => {
	ext.mcpScope = RELAY_MCP_INSIGHT_SCOPE;
});

Then("every new MCP tool answers it", async () => {
	const world = await insightWorld();
	const beforeDecisions = (
		await world.journal.decisions({
			accountId: "acct-1",
			repository: undefined,
			sinceMs: 0,
			limit: 100,
		})
	).length;
	const beforeMachines = (await world.registry.list("acct-1")).length;
	const caller = { accountId: "acct-1", scopes: [ext.mcpScope] };

	const calls: Array<readonly [string, JsonObject]> = [
		["get_runner_order", { repository: REPO }],
		["explain_route", { repository: REPO, inputs: { github: "ubuntu-24.04" } }],
		["list_route_decisions", {}],
		["list_machines", {}],
		["get_signals", { repository: REPO }],
		["get_job_times", { repository: REPO }],
		["get_run_failures", { repository: REPO, runId: 200 }],
		["get_usage", { repository: REPO }],
	];
	for (const [name, args] of calls) {
		const res = await callTool(world.services, name, args, caller);
		assert.equal(res.isError, false, `${name} failed with read scope: ${res.text}`);
	}
	const afterDecisions = (
		await world.journal.decisions({
			accountId: "acct-1",
			repository: undefined,
			sinceMs: 0,
			limit: 100,
		})
	).length;
	const afterMachines = (await world.registry.list("acct-1")).length;
	ext.mcpMutated =
		beforeDecisions !== afterDecisions || beforeMachines !== afterMachines;
});

Then("no MCP tool changes anything", () => {
	assert.equal(ext.mcpMutated, false);
});
