import type { HttpTransport } from "@hobo/core";

import { type ChaosFault, chaosTransport } from "./chaos.js";

export const AMBIGUOUS_FAULTS: readonly ChaosFault[] = Object.freeze([
	"network-error",
	"timeout",
	"server-error",
	"truncated-body",
	"malformed-body",
]);

export interface ChaosSubject {
	readonly label: string;
	readonly create: (
		wrap: (inner: HttpTransport) => HttpTransport,
	) => ChaosSubjectRun;
}

export interface ChaosSubjectRun {
	readonly reconcile: () => Promise<{
		readonly physicalId?: string;
		readonly action?: string;
	}>;
	readonly countResources: () => number;
	readonly countCreates: () => number;
}

export interface ChaosScenarioResult {
	readonly label: string;
	readonly fault: ChaosFault;
	readonly firstRejected: boolean;
	readonly writeLandedFirstAttempt: boolean;
	readonly resourcesAfterRetry: number;
	readonly createsAfterRetry: number;
	readonly physicalIdStable: boolean;
	readonly retryAction: string | undefined;
	readonly violations: readonly string[];
}

export async function runChaosConformance(
	subject: ChaosSubject,
	options: { readonly writeCallIndex: number },
): Promise<readonly ChaosScenarioResult[]> {
	const results: ChaosScenarioResult[] = [];

	for (const fault of AMBIGUOUS_FAULTS) {
		results.push(await runOne(subject, fault, options.writeCallIndex));
	}
	return results;
}

async function runOne(
	subject: ChaosSubject,
	fault: ChaosFault,
	writeCallIndex: number,
): Promise<ChaosScenarioResult> {
	let injecting = true;
	const run = subject.create((inner) => {
		const faulted = chaosTransport(inner, [{ at: writeCallIndex, fault }]);
		return async (request) =>
			injecting ? faulted.transport(request) : inner(request);
	});

	let firstRejected = false;
	try {
		await run.reconcile();
	} catch {
		firstRejected = true;
	}
	const createsFirstAttempt = run.countCreates();
	const resourcesFirstAttempt = run.countResources();
	const writeLandedFirstAttempt = resourcesFirstAttempt > 0;

	injecting = false;
	let retry: { physicalId?: string; action?: string } = {};
	let retryRejected = false;
	try {
		retry = await run.reconcile();
	} catch {
		retryRejected = true;
	}

	const resourcesAfterRetry = run.countResources();
	const createsAfterRetry = run.countCreates();

	const violations: string[] = [];
	if (retryRejected) {
		violations.push(
			"the retry itself rejected — after an ambiguous failure a resolver must be able to look and adopt",
		);
	}
	if (resourcesAfterRetry > 1) {
		violations.push(
			`retry produced ${resourcesAfterRetry} resources; an ambiguous failure must converge to 1`,
		);
	}
	if (writeLandedFirstAttempt && createsAfterRetry > createsFirstAttempt) {
		violations.push(
			`the write landed on the first attempt but the retry issued another create (${createsFirstAttempt} -> ${createsAfterRetry}); it must read first and adopt`,
		);
	}
	if (writeLandedFirstAttempt && retry.action === "create") {
		violations.push(
			'the write landed on the first attempt, so the retry must not report action "create"',
		);
	}
	if (!writeLandedFirstAttempt && resourcesAfterRetry !== 1) {
		violations.push(
			`the fault prevented the write, so the retry should have created exactly one resource, not ${resourcesAfterRetry}`,
		);
	}
	if (retry.action === "replace") {
		violations.push(
			'retry reported action "replace" — recovering from a lost response must never destroy a resource',
		);
	}

	return {
		label: subject.label,
		fault,
		firstRejected,
		writeLandedFirstAttempt,
		resourcesAfterRetry,
		createsAfterRetry,
		physicalIdStable: typeof retry.physicalId === "string",
		retryAction: retry.action,
		violations,
	};
}

export function chaosViolations(
	results: readonly ChaosScenarioResult[],
): readonly string[] {
	return results.flatMap((result) =>
		result.violations.map(
			(violation) => `${result.label} [${result.fault}]: ${violation}`,
		),
	);
}
