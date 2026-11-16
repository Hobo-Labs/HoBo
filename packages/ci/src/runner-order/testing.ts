/**
 * In-memory fakes of every runner-order port, and one conformance function
 * per port that each real implementation must pass.
 *
 * A conformance function takes a factory, runs the port's rules against what
 * it makes, and throws a `PortConformanceError` naming the first rule broken.
 * It imports no test framework, so a package's own test calls it:
 *
 *     it("keeps the journal's rules", () =>
 *       routeJournalConformance(() => new SqliteRouteJournal(db)));
 *
 * The fakes pass their own conformance functions (see
 * `test/runner-order-ports.test.ts`), so a later package can test against
 * them before the real port exists.
 */
import { create } from "@bufbuild/protobuf";
import {
	type MachineAdvert,
	MachineAdvertSchema,
	type RelayJobMessage,
	RelayJobMessageSchema,
	type RunnerRouteEvent,
	RunnerRouteEventSchema,
} from "../_generated/relay_job_pb.js";
import {
	type RunnerRouteRequest,
	RunnerRouteRequestSchema,
} from "../_generated/runner_route_pb.js";
import type { InsightRun } from "../insights/types.js";
import { NO_ROUTE_FACTS, type RouteFacts } from "./decide.js";
import {
	newProviderHealth,
	type ProviderHealth,
	providerHealthState,
	recordProviderOutcome,
} from "./health.js";
import type { MinutesUsage } from "./limits.js";
import type { MachineSharing } from "./machines.js";
import { DEFAULT_RUNNER_ORDER, parseRunnerOrder } from "./order.js";
import type {
	InsightRunQuery,
	InsightStore,
	MachineRegistry,
	MinutesReader,
	ProviderHealthStore,
	RouteDecisionQuery,
	RouteFactsSource,
	RouteJournal,
	RunnerOrderLookup,
	RunnerOrderSource,
	SpendReader,
} from "./ports.js";
import type { HostedRunnerProvider } from "./providers.js";
import { defineMachineAdvert, defineRunnerRouteEvent } from "./relay-job.js";

/** A port broke one of its rules. The message names the rule. */
export class PortConformanceError extends Error {
	override readonly name = "PortConformanceError";
}

function rule(ok: boolean, text: string): void {
	if (!ok) throw new PortConformanceError(text);
}

/** A relay job message for tests: a private push to `octo/app`, overridable field by field. */
export function testRelayJobMessage(
	init: Partial<
		Omit<RelayJobMessage, "$typeName" | "$unknown" | "inputs" | "steps">
	> &
		Readonly<{
			/** The relay's `with:` inputs as name and value; GitHub only when absent. */
			inputs?: readonly (readonly [string, string])[];
			/** The `uses:` of each step of the job. */
			uses?: readonly string[];
		}> = {},
): RelayJobMessage {
	const { inputs, uses, ...fields } = init;
	return create(RelayJobMessageSchema, {
		jobId: "job-1",
		planId: "plan-1",
		repository: "octo/app",
		runId: 9001,
		runAttempt: 1,
		job: "route",
		event: "push",
		actorId: "42",
		triggeringActorId: "42",
		private: true,
		...fields,
		inputs: (inputs ?? [["github", "ubuntu-24.04"]]).map(([name, value]) => ({
			name,
			value,
		})),
		steps: (uses ?? []).map((path) => ({ uses: path })),
	});
}

/** A route request for tests: a private push to `octo/app` naming only GitHub. */
export function testRouteRequest(
	repository = "octo/app",
	runId = 9001,
): RunnerRouteRequest {
	return create(RunnerRouteRequestSchema, {
		repository,
		private: true,
		event: "push",
		runId,
		runAttempt: 1,
		job: "route",
		inputs: [{ key: "github", labels: ["ubuntu-24.04"] }],
	});
}

/** A machine advert for tests, owned by user 42 in account `acct-1`. */
export function testMachineAdvert(
	init: Partial<Omit<MachineAdvert, "$typeName" | "$unknown">> = {},
): MachineAdvert {
	return defineMachineAdvert(
		create(MachineAdvertSchema, {
			id: "m-1",
			accountId: "acct-1",
			name: "studio",
			runsOn: `hobo-machine-${init.id ?? "m-1"}`,
			labels: ["self-hosted", "Linux", "X64"],
			os: "linux",
			arch: "x64",
			slots: 1,
			sharing: "only_me",
			ownerId: "42",
			ownerLogin: "octocat",
			lastSeenMs: 1,
			signerKeyId: "key-1",
			isolation: "container",
			...init,
		}),
	);
}

// --- Runner order source -------------------------------------------------

/**
 * Orders by repository, as the `runnerOrder` JSON text of `.hobo/ci.json`.
 * A repository with none gets the default order.
 */
export class InMemoryRunnerOrderSource implements RunnerOrderSource {
	readonly asked: Array<
		Readonly<{ repository: string; ref: string | undefined }>
	> = [];
	constructor(
		private readonly orders: ReadonlyMap<string, string> = new Map(),
	) {}

	async order(
		repository: string,
		ref: string | undefined,
	): Promise<RunnerOrderLookup> {
		this.asked.push({ repository, ref });
		const json = this.orders.get(repository.toLowerCase());
		if (json === undefined) return { order: DEFAULT_RUNNER_ORDER, problem: "" };
		try {
			return { order: parseRunnerOrder(json), problem: "" };
		} catch (error) {
			return {
				order: DEFAULT_RUNNER_ORDER,
				problem: error instanceof Error ? error.message : String(error),
			};
		}
	}
}

/**
 * A runner order source keeps its rules. `make` receives each repository's
 * `runnerOrder` JSON text, keyed by lower-case `owner/name`.
 */
export async function runnerOrderSourceConformance(
	make: (
		orders: ReadonlyMap<string, string>,
	) => RunnerOrderSource | Promise<RunnerOrderSource>,
): Promise<void> {
	const written = '{"steps":[{"key":"machine"},{"key":"github"}]}';
	const source = await make(
		new Map([
			["octo/app", written],
			["octo/broken", '{"steps":[]}'],
		]),
	);
	const found = await source.order("octo/app", undefined);
	rule(found.problem === "", "a committed order that parses has no problem");
	rule(
		found.order.steps.map((step) => step.key).join(",") === "machine,github",
		"a committed order is returned as written",
	);
	rule(Object.isFrozen(found.order), "an order comes back parsed and frozen");
	const broken = await source.order("octo/broken", undefined);
	rule(
		broken.problem.length > 0,
		"an order that does not parse comes back with the parser's sentence",
	);
	rule(
		broken.order === DEFAULT_RUNNER_ORDER,
		"an order that does not parse comes back as the default",
	);
	const none = await source.order("octo/none", undefined);
	rule(
		none.problem === "" && none.order === DEFAULT_RUNNER_ORDER,
		"a repository with no order gets the default and no problem",
	);
}

// --- Route facts source --------------------------------------------------

/** Facts made from each request; nothing measured unless told otherwise. */
export class InMemoryRouteFactsSource implements RouteFactsSource {
	readonly asked: Array<
		Readonly<{ request: RunnerRouteRequest; nowMs: number }>
	> = [];
	constructor(
		private readonly answer: (
			request: RunnerRouteRequest,
			nowMs: number,
		) => RouteFacts = () => NO_ROUTE_FACTS,
	) {}

	async facts(request: RunnerRouteRequest, nowMs: number): Promise<RouteFacts> {
		this.asked.push({ request, nowMs });
		return this.answer(request, nowMs);
	}
}

/**
 * A facts source keeps its rules: a repository it knows nothing about still
 * gets facts (a missing measurement never blocks), and every measurement it
 * gives is a real number.
 */
export async function routeFactsSourceConformance(
	make: () => RouteFactsSource | Promise<RouteFactsSource>,
): Promise<void> {
	const source = await make();
	const facts = await source.facts(testRouteRequest("octo/never-seen"), 1_000);
	rule(Array.isArray(facts.machines), "machines is a list");
	rule(facts.spendUsd instanceof Map, "spend is a map by provider");
	rule(facts.unhealthy instanceof Set, "unhealthy runner types are a set");
	for (const usd of facts.spendUsd.values())
		rule(Number.isFinite(usd) && usd >= 0, "a spend is a non-negative number");
	if (facts.minutes)
		rule(
			facts.minutes.usedMinutes >= 0 && facts.minutes.includedMinutes >= 0,
			"minutes are non-negative",
		);
	for (const machine of facts.machines)
		rule(machine.busy >= 0 && machine.slots >= 1, "a machine has slots");
}

// --- Route journal -------------------------------------------------------

function journalKey(event: RunnerRouteEvent): string | undefined {
	return event.jobId === "" ? undefined : `${event.jobId}\u0000${event.type}`;
}

/** Entries in memory, newest first on read. */
export class InMemoryRouteJournal implements RouteJournal {
	readonly events: RunnerRouteEvent[] = [];

	async record(event: RunnerRouteEvent): Promise<void> {
		const parsed = defineRunnerRouteEvent(event);
		const key = journalKey(parsed);
		if (key && this.events.some((kept) => journalKey(kept) === key)) return;
		this.events.push(parsed);
	}

	async decisions(
		query: RouteDecisionQuery,
	): Promise<readonly RunnerRouteEvent[]> {
		const repository = query.repository?.toLowerCase();
		return this.events
			.filter(
				(event) =>
					event.accountId === query.accountId &&
					event.atMs >= query.sinceMs &&
					(repository === undefined ||
						event.request?.repository.toLowerCase() === repository),
			)
			.map((event, index) => ({ event, index }))
			.sort(
				(left, right) =>
					right.event.atMs - left.event.atMs || right.index - left.index,
			)
			.slice(0, Math.max(0, query.limit))
			.map(({ event }) => event);
	}
}

function routeEvent(
	init: Readonly<{
		type: "runner.route.Requested" | "runner.route.Decided";
		accountId: string;
		atMs: number;
		repository: string;
		jobId: string;
	}>,
): RunnerRouteEvent {
	return create(RunnerRouteEventSchema, {
		type: init.type,
		accountId: init.accountId,
		atMs: init.atMs,
		request: testRouteRequest(init.repository),
		decision:
			init.type === "runner.route.Decided"
				? { outcome: "routed", runner: "ubuntu-24.04", step: "github" }
				: undefined,
		mode: "relay",
		node: "node-1",
		jobId: init.jobId,
	});
}

/** A route journal keeps its rules: newest first, scoped, bounded, and a redelivery is one entry. */
export async function routeJournalConformance(
	make: () => RouteJournal | Promise<RouteJournal>,
): Promise<void> {
	const journal = await make();
	const base = { accountId: "acct-1", repository: "octo/app" };
	await journal.record(
		routeEvent({
			...base,
			type: "runner.route.Requested",
			atMs: 1_000,
			jobId: "j1",
		}),
	);
	await journal.record(
		routeEvent({
			...base,
			type: "runner.route.Decided",
			atMs: 2_000,
			jobId: "j1",
		}),
	);
	await journal.record(
		routeEvent({
			...base,
			type: "runner.route.Decided",
			atMs: 9_000,
			jobId: "j1",
		}),
	);
	await journal.record(
		routeEvent({
			...base,
			repository: "octo/other",
			type: "runner.route.Decided",
			atMs: 3_000,
			jobId: "j2",
		}),
	);
	await journal.record(
		routeEvent({
			...base,
			accountId: "acct-2",
			type: "runner.route.Decided",
			atMs: 4_000,
			jobId: "j3",
		}),
	);
	const all = await journal.decisions({
		accountId: "acct-1",
		repository: undefined,
		sinceMs: 0,
		limit: 10,
	});
	rule(
		all.length === 3,
		"a redelivered event is kept once, and other accounts are left out",
	);
	rule(
		all.map((event) => event.atMs).join(",") === "3000,2000,1000",
		"entries come back newest first, the first delivery kept",
	);
	const scoped = await journal.decisions({
		accountId: "acct-1",
		repository: "Octo/App",
		sinceMs: 1_500,
		limit: 10,
	});
	rule(
		scoped.length === 1 && scoped[0]?.type === "runner.route.Decided",
		"a repository and a start time narrow the read, case ignored",
	);
	const limited = await journal.decisions({
		accountId: "acct-1",
		repository: undefined,
		sinceMs: 0,
		limit: 1,
	});
	rule(
		limited.length === 1 && limited[0]?.atMs === 3_000,
		"limit bounds the read",
	);
	const decided = all.find((event) => event.type === "runner.route.Decided");
	rule(
		decided?.decision?.runner === "ubuntu-24.04",
		"a decision is kept with its entry",
	);
}

// --- Machine registry ----------------------------------------------------

/** Machines in memory. Every change is kept in `changes` for assertions. */
export class InMemoryMachineRegistry implements MachineRegistry {
	private readonly machines = new Map<string, MachineAdvert>();
	readonly changes: Array<
		Readonly<{ id: string; change: string; by: string }>
	> = [];

	async list(accountId: string): Promise<readonly MachineAdvert[]> {
		return [...this.machines.values()]
			.filter((machine) => machine.accountId === accountId)
			.sort((left, right) =>
				left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
			);
	}

	async put(advert: MachineAdvert): Promise<void> {
		this.machines.set(
			advert.id,
			defineMachineAdvert(create(MachineAdvertSchema, advert)),
		);
		this.changes.push({ id: advert.id, change: "put", by: advert.ownerLogin });
	}

	private known(id: string): MachineAdvert {
		const machine = this.machines.get(id);
		if (!machine) throw new Error(`no machine ${id}`);
		return machine;
	}

	async setPaused(id: string, paused: boolean, by: string): Promise<void> {
		const machine = this.known(id);
		this.machines.set(
			id,
			defineMachineAdvert(create(MachineAdvertSchema, { ...machine, paused })),
		);
		this.changes.push({ id, change: paused ? "paused" : "resumed", by });
	}

	async setSharing(id: string, sharing: MachineSharing): Promise<void> {
		const machine = this.known(id);
		this.machines.set(
			id,
			defineMachineAdvert(create(MachineAdvertSchema, { ...machine, sharing })),
		);
		this.changes.push({ id, change: `sharing:${sharing}`, by: "" });
	}

	async remove(id: string): Promise<void> {
		if (this.machines.delete(id))
			this.changes.push({ id, change: "removed", by: "" });
	}
}

async function throws(action: () => Promise<void>): Promise<boolean> {
	try {
		await action();
		return false;
	} catch {
		return true;
	}
}

/** A machine registry keeps its rules: scoped by account, replace on put, pause, share, remove at once. */
export async function machineRegistryConformance(
	make: () => MachineRegistry | Promise<MachineRegistry>,
): Promise<void> {
	const registry = await make();
	await registry.put(testMachineAdvert({ id: "m-2", slots: 2 }));
	await registry.put(testMachineAdvert({ id: "m-1" }));
	await registry.put(testMachineAdvert({ id: "m-9", accountId: "acct-2" }));
	const listed = await registry.list("acct-1");
	rule(
		listed.map((machine) => machine.id).join(",") === "m-1,m-2",
		"list returns the account's machines in id order",
	);
	await registry.put(testMachineAdvert({ id: "m-2", slots: 4 }));
	const replaced = (await registry.list("acct-1")).find((m) => m.id === "m-2");
	rule(replaced?.slots === 4, "put replaces a machine's advert");
	await registry.setPaused("m-1", true, "octocat");
	rule(
		(await registry.list("acct-1")).find((m) => m.id === "m-1")?.paused ===
			true,
		"a paused machine reads back paused",
	);
	await registry.setPaused("m-1", false, "octocat");
	rule(
		(await registry.list("acct-1")).find((m) => m.id === "m-1")?.paused ===
			false,
		"a resumed machine reads back unpaused",
	);
	await registry.setSharing("m-1", "anyone");
	rule(
		(await registry.list("acct-1")).find((m) => m.id === "m-1")?.sharing ===
			"anyone",
		"sharing reads back as set",
	);
	rule(
		await throws(() => registry.setPaused("nope", true, "octocat")),
		"pausing an unknown machine throws",
	);
	rule(
		await throws(() => registry.setSharing("nope", "anyone")),
		"sharing an unknown machine throws",
	);
	await registry.remove("m-1");
	await registry.remove("nope");
	rule(
		(await registry.list("acct-1")).map((machine) => machine.id).join(",") ===
			"m-2",
		"a removed machine is gone at once",
	);
}

// --- Provider health -----------------------------------------------------

/** Provider health records in memory. */
export class InMemoryProviderHealthStore implements ProviderHealthStore {
	private readonly records = new Map<string, ProviderHealth>();

	async get(key: string): Promise<ProviderHealth> {
		return this.records.get(key) ?? newProviderHealth();
	}

	async put(key: string, health: ProviderHealth): Promise<void> {
		this.records.set(key, health);
	}

	async unhealthy(nowMs: number): Promise<ReadonlySet<string>> {
		const keys = new Set<string>();
		for (const [key, health] of this.records)
			if (providerHealthState(health, nowMs) === "unhealthy") keys.add(key);
		return keys;
	}
}

/** A provider health store keeps its rules: a new key is healthy, records survive, a trial is let through. */
export async function providerHealthStoreConformance(
	make: () => ProviderHealthStore | Promise<ProviderHealthStore>,
): Promise<void> {
	const store = await make();
	const key = "depot:depot-ubuntu-24.04";
	const fresh = await store.get(key);
	rule(
		fresh.trippedAtMs === undefined && fresh.outcomes.length === 0,
		"a key never recorded is healthy",
	);
	let health = fresh;
	for (const atMs of [1_000, 2_000, 3_000])
		health = recordProviderOutcome(health, { atMs, started: false });
	await store.put(key, health);
	await store.put("blacksmith:x", newProviderHealth());
	const kept = await store.get(key);
	rule(
		kept.trippedAtMs === 3_000 && kept.outcomes.length === 3,
		"a record reads back as put",
	);
	const tripped = await store.unhealthy(3_000);
	rule(
		tripped.has(key) && !tripped.has("blacksmith:x"),
		"a tripped type is unhealthy and a healthy one is not",
	);
	rule(
		!(await store.unhealthy(3_000 + 24 * 60 * 60_000)).has(key),
		"a tripped type due a trial is not passed over",
	);
}

// --- Billing reads -------------------------------------------------------

/** Minutes by owner; an owner with none is unmeasured. */
export class InMemoryMinutesReader implements MinutesReader {
	constructor(
		private readonly byOwner: ReadonlyMap<string, MinutesUsage> = new Map(),
	) {}

	async usage(owner: string): Promise<MinutesUsage | undefined> {
		return this.byOwner.get(owner.toLowerCase());
	}
}

/** A minutes reader keeps its rules: an unknown owner is unmeasured or real, never negative. */
export async function minutesReaderConformance(
	make: () => MinutesReader | Promise<MinutesReader>,
): Promise<void> {
	const reader = await make();
	const usage = await reader.usage("never-seen-owner");
	if (usage)
		rule(
			usage.usedMinutes >= 0 && usage.includedMinutes >= 0,
			"minutes are non-negative",
		);
}

/** Spend by account; an account with none has nothing measured. */
export class InMemorySpendReader implements SpendReader {
	readonly asked: Array<Readonly<{ accountId: string; monthStartMs: number }>> =
		[];
	constructor(
		private readonly byAccount: ReadonlyMap<
			string,
			ReadonlyMap<HostedRunnerProvider, number>
		> = new Map(),
	) {}

	async spentUsd(
		accountId: string,
		monthStartMs: number,
	): Promise<ReadonlyMap<HostedRunnerProvider, number>> {
		this.asked.push({ accountId, monthStartMs });
		return this.byAccount.get(accountId) ?? new Map();
	}
}

/** A spend reader keeps its rules: an unknown account gets a map, every value non-negative. */
export async function spendReaderConformance(
	make: () => SpendReader | Promise<SpendReader>,
): Promise<void> {
	const reader = await make();
	const spent = await reader.spentUsd("never-seen-account", 0);
	rule(spent instanceof Map, "spend is a map by provider");
	for (const usd of spent.values())
		rule(Number.isFinite(usd) && usd >= 0, "a spend is a non-negative number");
}

// --- Insight store -------------------------------------------------------

/** Run attempts in memory, keyed by run id and attempt. */
export class InMemoryInsightStore implements InsightStore {
	private readonly kept = new Map<string, InsightRun>();

	async ingest(run: InsightRun): Promise<void> {
		this.kept.set(`${run.id}:${run.attempt}`, run);
	}

	async runs(query: InsightRunQuery): Promise<readonly InsightRun[]> {
		const repository = query.repository.toLowerCase();
		return [...this.kept.values()]
			.filter(
				(run) =>
					run.repository.toLowerCase() === repository &&
					run.createdAtMs >= query.sinceMs,
			)
			.sort(
				(left, right) =>
					right.createdAtMs - left.createdAtMs ||
					right.id - left.id ||
					right.attempt - left.attempt,
			)
			.slice(0, Math.max(0, query.limit));
	}
}

function testRun(
	id: number,
	attempt: number,
	createdAtMs: number,
	repository = "octo/app",
): InsightRun {
	return {
		id,
		attempt,
		repository,
		workflow: "CI",
		workflowPath: ".github/workflows/ci.yml",
		event: "push",
		branch: "main",
		defaultBranch: "main",
		headSha: "0123456789abcdef0123456789abcdef01234567",
		actor: "octocat",
		conclusion: "success",
		createdAtMs,
		jobs: [
			{
				id: id * 10,
				name: "test",
				labels: ["ubuntu-24.04"],
				conclusion: "success",
				queuedAtMs: createdAtMs,
				startedAtMs: createdAtMs + 1_000,
				completedAtMs: createdAtMs + 61_000,
				steps: [{ name: "Set up job", number: 1, conclusion: "success" }],
				billed: true,
			},
		],
	};
}

/** An insight store keeps its rules: replace by attempt, scoped, newest first, bounded, intact. */
export async function insightStoreConformance(
	make: () => InsightStore | Promise<InsightStore>,
): Promise<void> {
	const store = await make();
	await store.ingest(testRun(1, 1, 1_000));
	await store.ingest(testRun(1, 2, 2_000));
	await store.ingest(testRun(2, 1, 3_000));
	await store.ingest({ ...testRun(2, 1, 3_000), conclusion: "failure" });
	await store.ingest(testRun(3, 1, 4_000, "octo/other"));
	const all = await store.runs({
		repository: "Octo/App",
		sinceMs: 0,
		limit: 10,
	});
	rule(
		all.map((run) => `${run.id}.${run.attempt}`).join(",") === "2.1,1.2,1.1",
		"runs come back newest first, each attempt once, other repositories left out",
	);
	rule(
		all[0]?.conclusion === "failure",
		"ingesting an attempt again replaces it",
	);
	rule(
		all[0]?.jobs[0]?.steps[0]?.name === "Set up job" &&
			all[0]?.jobs[0]?.startedAtMs === 4_000,
		"a run reads back with its jobs and steps intact",
	);
	const recent = await store.runs({
		repository: "octo/app",
		sinceMs: 1_500,
		limit: 1,
	});
	rule(
		recent.length === 1 && recent[0]?.id === 2,
		"a start time and a limit narrow the read",
	);
}
