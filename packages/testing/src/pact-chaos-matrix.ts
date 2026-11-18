import type { HttpTransport } from "@hobo/core";

import { CHAOS_FAULTS, type ChaosFault, chaosTransport } from "./chaos.js";
import {
	fetchFromTransport,
	type PactFidelityViolation,
	type PactLifecycle,
	type PactWorld,
} from "./pact-chaos.js";

export const WRITE_REACHING_FAULTS: readonly ChaosFault[] = Object.freeze([
	"truncated-body",
	"malformed-body",
]);

export type PactChaosScenarioKind = "single" | "double" | "teardown";

export interface PactChaosRun {
	readonly converge: () => Promise<void>;
	readonly observe: () => Promise<readonly unknown[]>;
	readonly remove?: () => Promise<void>;
}

export interface PactChaosSubject {
	readonly label: string;
	readonly lifecycle: PactLifecycle;
	readonly world: (lifecycle: PactLifecycle) => PactWorld;
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
	readonly firstRejected: boolean;
	readonly writeLanded: boolean;
	readonly createsBeforeRetry: number;
	readonly createsAfterRetry: number;
	readonly observedAfterRetry: number;
	readonly finalState: string;
	readonly fidelity: readonly PactFidelityViolation[];
	readonly violations: readonly string[];
}

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
		for (const at of [0, 1]) {
			const teardown = await runTeardown(subject, fault, at);
			if (teardown) results.push(teardown);
		}
	}

	return results;
}

async function runSingle(
	subject: PactChaosSubject,
	fault: ChaosFault,
	at: number,
): Promise<PactChaosScenarioResult> {
	const world = subject.world(subject.lifecycle);
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

	await rejected(run.converge);
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

interface DriverObservation {
	createsAfterFailedRead: number;
	createsAfterKnownPresent: number;
}

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
			lastFailed = true;
			lastShowedPresent = false;
			throw error;
		}
	};
	return { transport, fetchImpl: fetchFromTransport(transport) };
}

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

export function pactChaosViolations(
	results: readonly PactChaosScenarioResult[],
): readonly string[] {
	return results.flatMap((r) =>
		r.violations.map((v) => `${r.label} [${r.kind} ${r.fault} @${r.at}]: ${v}`),
	);
}
