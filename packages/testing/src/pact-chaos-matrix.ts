/**
 * Every failure state, not just the interesting one.
 *
 * `runChaosConformance` faults one call — the write — because that is where
 * duplication hides. That is the best single scenario and about a fifth of the
 * surface: dying on the lookup, during teardown, or twice in a row never runs.
 * This sweeps every fault at every call index, then adds the two shapes an
 * index sweep cannot express (a fault during the recovery, and during teardown).
 *
 * It asserts two properties, both computed from the pact:
 *
 *  - **Convergence** — a retry lands exactly one resource, with a stable
 *    identity, without destroying anything.
 *  - **Fidelity** — every request sent while recovering still matches the
 *    contract. Recovery takes branches the happy path never takes, so a driver
 *    can converge while talking nonsense; that ships as a 400 on the first real
 *    retry, and only a fidelity check catches it here.
 */
import type { HttpTransport } from "@hobo/core";

import { CHAOS_FAULTS, type ChaosFault, chaosTransport } from "./chaos.js";
import {
	fetchFromTransport,
	type PactFidelityViolation,
	type PactLifecycle,
	type PactWorld,
} from "./pact-chaos.js";

/**
 * Faults that reach the provider and corrupt only the response — the write
 * landed, the client never learned. Everything else aborts first.
 *
 * The matrix never consults this to decide what to expect; it reads the world's
 * real state via `writeLanded`. Exported so callers can assert the two agree:
 * disagreement means chaos stopped passing writes through, which is harness rot.
 */
export const WRITE_REACHING_FAULTS: readonly ChaosFault[] = Object.freeze([
	"truncated-body",
	"malformed-body",
]);

export type PactChaosScenarioKind =
	/** One fault, then a clean retry. */
	| "single"
	/** A fault on the retry as well, then a clean third attempt. */
	| "double"
	/** Converge cleanly, then fault the teardown and retry it. */
	| "teardown";

export interface PactChaosRun {
	/** The convergent operation: upsert, apply, reconcile. May reject. */
	readonly converge: () => Promise<void>;
	/** What the provider holds now. Length is the convergence assertion. */
	readonly observe: () => Promise<readonly unknown[]>;
	/** Teardown, if the driver has one. Enables the teardown scenarios. */
	readonly remove?: () => Promise<void>;
}

export interface PactChaosSubject {
	/** Names the driver in failure output. */
	readonly label: string;
	readonly lifecycle: PactLifecycle;
	/** Builds a fresh world for one scenario. */
	readonly world: (lifecycle: PactLifecycle) => PactWorld;
	/**
	 * Binds the driver to a transport the runner already wrapped in chaos. The
	 * runner owns the wrapping because faults are indexed by call number across
	 * the whole scenario; self-wrapping would restart that count.
	 */
	readonly bind: (bound: {
		readonly transport: HttpTransport;
		readonly fetchImpl: typeof fetch;
	}) => PactChaosRun;
}

export interface PactChaosScenarioResult {
	readonly label: string;
	readonly kind: PactChaosScenarioKind;
	readonly fault: ChaosFault;
	readonly at: number;
	/** Did the faulted attempt reject, or return despite the fault? */
	readonly firstRejected: boolean;
	/** Did the write reach the provider before the fault fired? */
	readonly writeLanded: boolean;
	readonly createsBeforeRetry: number;
	readonly createsAfterRetry: number;
	readonly observedAfterRetry: number;
	readonly finalState: string;
	readonly fidelity: readonly PactFidelityViolation[];
	readonly violations: readonly string[];
}

/** How many calls the driver makes with nothing going wrong. */
export async function baselineCallCount(
	subject: PactChaosSubject,
): Promise<number> {
	const world = subject.world(subject.lifecycle);
	const run = subject.bind({
		transport: world.transport,
		fetchImpl: world.fetchImpl,
	});
	await run.converge();
	return world.calls.length;
}

/**
 * Every fault at every call index, plus double-fault and teardown.
 *
 * All six faults, not just the five ambiguous ones. A 429 is unambiguous for
 * the *provider*, but a driver that treats it as fatal — or retries it into a
 * duplicate — should fail here rather than in production.
 */
export async function runPactChaosMatrix(
	subject: PactChaosSubject,
): Promise<readonly PactChaosScenarioResult[]> {
	const callCount = await baselineCallCount(subject);
	const results: PactChaosScenarioResult[] = [];

	for (const fault of CHAOS_FAULTS) {
		for (let at = 0; at < callCount; at += 1) {
			results.push(await runSingle(subject, fault, at));
		}
		results.push(await runDouble(subject, fault, callCount));
		// Teardown indices count from the start of the teardown: a read-then-delete
		// driver makes the delete its call 1, and call 0 is the lookup.
		for (const at of [0, 1]) {
			const teardown = await runTeardown(subject, fault, at);
			if (teardown) results.push(teardown);
		}
	}

	return results;
}

/** Faults one call, retries clean, and asks whether the world converged. */
async function runSingle(
	subject: PactChaosSubject,
	fault: ChaosFault,
	at: number,
): Promise<PactChaosScenarioResult> {
	const world = subject.world(subject.lifecycle);
	// Every call goes through chaos, including the retry's — gating per attempt
	// would desync chaos's call counter from the world's. Only the scheduled
	// index faults; the rest pass straight through.
	const seen: DriverObservation = {
		createsAfterFailedRead: 0,
		createsAfterKnownPresent: 0,
	};
	const faulted = chaosTransport(world.transport, [{ at, fault }]);
	const run = subject.bind(
		bound(() => faulted.transport, subject.lifecycle, seen),
	);

	const firstRejected = await rejected(run.converge);
	const writeLanded = world.state() === subject.lifecycle.created;
	const createsBeforeRetry = world.countCreates();

	const retryRejected = await rejected(run.converge);
	const observed = await run.observe().catch(() => []);

	return finish({
		subject,
		seen,
		kind: "single",
		fault,
		at,
		world,
		firstRejected,
		writeLanded,
		createsBeforeRetry,
		retryRejected,
		observed,
		extra: [],
	});
}

/**
 * The scenario an index sweep cannot reach: the recovery itself fails. A driver
 * that caches "I looked and it was absent" converges under one fault and
 * duplicates under two.
 *
 * The second fault goes on the call after the write — the recovery's first call
 * for a read-then-write driver. For one that keeps calling after its write it
 * lands inside attempt 1 instead; still a real two-fault run, and `at` is
 * reported so either way it is reproducible.
 */
async function runDouble(
	subject: PactChaosSubject,
	fault: ChaosFault,
	callCount: number,
): Promise<PactChaosScenarioResult> {
	const world = subject.world(subject.lifecycle);
	const writeIndex = Math.max(0, callCount - 1);
	const seen: DriverObservation = {
		createsAfterFailedRead: 0,
		createsAfterKnownPresent: 0,
	};
	const faulted = chaosTransport(world.transport, [
		{ at: writeIndex, fault },
		{ at: writeIndex + 1, fault },
	]);
	const run = subject.bind(
		bound(() => faulted.transport, subject.lifecycle, seen),
	);

	const firstRejected = await rejected(run.converge);
	const writeLanded = world.state() === subject.lifecycle.created;
	const createsBeforeRetry = world.countCreates();

	await rejected(run.converge); // the second, also-faulted attempt
	const retryRejected = await rejected(run.converge);
	const observed = await run.observe().catch(() => []);

	return finish({
		subject,
		seen,
		kind: "double",
		fault,
		at: writeIndex,
		world,
		firstRejected,
		writeLanded,
		createsBeforeRetry,
		retryRejected,
		observed,
		extra: [],
	});
}

/**
 * Converge cleanly, then fault the teardown. "Already gone is success" is the
 * delete-side twin of read-or-create, and it decides whether a failed
 * `hobo down` can be re-run or needs hand cleanup.
 *
 * Teardown gets its own chaos transport so the fault index counts from the
 * start of teardown — the preceding converge makes a driver-dependent number
 * of calls, so an absolute index would land differently per subject.
 */
async function runTeardown(
	subject: PactChaosSubject,
	fault: ChaosFault,
	at: number,
): Promise<PactChaosScenarioResult | undefined> {
	const world = subject.world(subject.lifecycle);
	let active: HttpTransport = world.transport;
	const seen: DriverObservation = {
		createsAfterFailedRead: 0,
		createsAfterKnownPresent: 0,
	};
	const run = subject.bind(bound(() => active, subject.lifecycle, seen));
	if (!run.remove) return undefined;

	await run.converge();

	const faulted = chaosTransport(world.transport, [{ at, fault }]);
	active = faulted.transport;
	const firstRejected = await rejected(run.remove);

	active = world.transport;
	const retryRejected = await rejected(run.remove);
	const observed = await run.observe().catch(() => []);

	const violations: string[] = [];
	if (retryRejected) {
		violations.push(
			"the second teardown rejected — a delete that finds nothing must succeed, or a failed teardown can never be re-run",
		);
	}
	if (observed.length !== 0) {
		violations.push(
			`teardown left ${observed.length} resource(s) behind after a retry`,
		);
	}
	if (world.state() === subject.lifecycle.created) {
		violations.push(
			`teardown returned but the world is still in state ${JSON.stringify(world.state())}`,
		);
	}
	for (const v of world.fidelityViolations()) {
		violations.push(
			`call ${v.callIndex} ${v.method} ${v.path}: ${v.kind} — ${v.detail}`,
		);
	}

	return {
		label: subject.label,
		kind: "teardown",
		fault,
		at,
		firstRejected,
		writeLanded: true,
		createsBeforeRetry: world.countCreates(),
		createsAfterRetry: world.countCreates(),
		observedAfterRetry: observed.length,
		finalState: world.state(),
		fidelity: world.fidelityViolations(),
		violations: Object.freeze(violations),
	};
}

/**
 * What the driver actually experienced, seen from outside the chaos wrapper.
 * It cannot live on the world: chaos answers aborted calls itself, so a
 * world-side counter would read zero for exactly the scenarios that matter.
 */
interface DriverObservation {
	/** Create-shaped calls issued when the last answer the driver got was an error. */
	createsAfterFailedRead: number;
	/** Create-shaped calls issued when the last answer showed the resource present. */
	createsAfterKnownPresent: number;
}

/**
 * One indirection so a scenario can swap which transport is live between
 * phases while the driver stays bound to a single object, and so every
 * request/response pair the driver saw can be classified.
 */
function bound(
	active: () => HttpTransport,
	lifecycle: PactLifecycle,
	seen: DriverObservation,
): { transport: HttpTransport; fetchImpl: typeof fetch } {
	let lastFailed = false;
	let lastShowedPresent = false;

	const transport: HttpTransport = async (request) => {
		const url = new URL(request.url);
		const selector = `${request.method} ${url.pathname}${url.search}`;
		if (lifecycle.creates.includes(selector)) {
			if (lastFailed) seen.createsAfterFailedRead += 1;
			if (lastShowedPresent) seen.createsAfterKnownPresent += 1;
		}
		try {
			const response = await active()(request);
			lastFailed = response.status >= 300;
			lastShowedPresent = !lastFailed && showsPresent(response.body);
			return response;
		} catch (error) {
			// A thrown transport error is the strongest form of "you did not learn
			// anything" — treated the same as a 5xx for the purpose of deciding
			// whether a following create was justified.
			lastFailed = true;
			lastShowedPresent = false;
			throw error;
		}
	};
	return { transport, fetchImpl: fetchFromTransport(transport) };
}

/**
 * Did this body show the driver a resource that already exists? Deliberately
 * shallow — any non-empty array anywhere. Provider-agnostic on purpose, so one
 * rule covers every subject whatever the envelope is called.
 */
function showsPresent(body: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body) as unknown;
	} catch {
		return false;
	}
	let present = false;
	const visit = (node: unknown): void => {
		if (present) return;
		if (Array.isArray(node)) {
			if (node.length > 0) present = true;
			return;
		}
		if (typeof node === "object" && node !== null) {
			for (const value of Object.values(node)) visit(value);
		}
	};
	visit(parsed);
	return present;
}

async function rejected(op: () => Promise<unknown>): Promise<boolean> {
	try {
		await op();
		return false;
	} catch {
		return true;
	}
}

function finish(input: {
	subject: PactChaosSubject;
	seen: DriverObservation;
	kind: PactChaosScenarioKind;
	fault: ChaosFault;
	at: number;
	world: PactWorld;
	firstRejected: boolean;
	writeLanded: boolean;
	createsBeforeRetry: number;
	retryRejected: boolean;
	observed: readonly unknown[];
	extra: readonly string[];
}): PactChaosScenarioResult {
	const { world, subject } = input;
	const createsAfterRetry = world.countCreates();
	const fidelity = world.fidelityViolations();
	const violations: string[] = [...input.extra];

	if (input.retryRejected) {
		violations.push(
			"the retry itself rejected — after a failure a driver must be able to look and adopt",
		);
	}
	if (input.observed.length > 1) {
		violations.push(
			`retry left ${input.observed.length} resources; a failure must converge to 1`,
		);
	}
	if (!input.retryRejected && input.observed.length === 0) {
		violations.push(
			"the retry reported success but the provider holds nothing — the driver believes it converged and it did not",
		);
	}
	// Duplication rules only mean anything when the provider mints the id. With
	// a client-supplied one a repeated write lands on the same resource, so it
	// is correct recovery — convergence is still checked above, by count/state.
	const canDuplicate = subject.lifecycle.identity !== "client-supplied";
	if (
		canDuplicate &&
		input.writeLanded &&
		createsAfterRetry > input.createsBeforeRetry
	) {
		violations.push(
			`the write landed before the fault but the retry issued another create (${input.createsBeforeRetry} -> ${createsAfterRetry}); it must read first and adopt`,
		);
	}
	if (!input.retryRejected && world.state() !== subject.lifecycle.created) {
		violations.push(
			`the retry reported success but the world is in state ${JSON.stringify(world.state())}, not ${JSON.stringify(subject.lifecycle.created)}`,
		);
	}
	if (canDuplicate && input.seen.createsAfterFailedRead > 0) {
		violations.push(
			`issued ${input.seen.createsAfterFailedRead} create(s) straight after a read that failed — a failed lookup is not evidence the resource is absent, and treating it as one is how a retry duplicates`,
		);
	}
	if (canDuplicate && input.seen.createsAfterKnownPresent > 0) {
		violations.push(
			`issued ${input.seen.createsAfterKnownPresent} create(s) after a read that showed the resource already present — the retry must adopt, not create`,
		);
	}
	for (const v of fidelity) {
		violations.push(
			`call ${v.callIndex} ${v.method} ${v.path}: ${v.kind} — ${v.detail}`,
		);
	}

	return {
		label: subject.label,
		kind: input.kind,
		fault: input.fault,
		at: input.at,
		firstRejected: input.firstRejected,
		writeLanded: input.writeLanded,
		createsBeforeRetry: input.createsBeforeRetry,
		createsAfterRetry,
		observedAfterRetry: input.observed.length,
		finalState: world.state(),
		fidelity,
		violations: Object.freeze(violations),
	};
}

/** Every violation across a matrix, formatted for one assertion. */
export function pactChaosViolations(
	results: readonly PactChaosScenarioResult[],
): readonly string[] {
	return results.flatMap((r) =>
		r.violations.map((v) => `${r.label} [${r.kind} ${r.fault} @${r.at}]: ${v}`),
	);
}
