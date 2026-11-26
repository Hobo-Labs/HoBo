/**
 * A chaos suite every provider's resolvers must survive, not just the one that
 * happened to get a test written for it.
 *
 * The existing chaos coverage drove Cloudflare R2 through injected faults and
 * proved the property that matters. But "R2 converges under a lost response"
 * says nothing about whether Azure, GCP, AWS or Vercel do, and those resolvers
 * were written by different hands against different API shapes. A convergence
 * bug is exactly the kind that hides until a real deploy retries.
 *
 * ## The property
 *
 * Every fault here has the same shape: **the caller does not learn whether the
 * write landed.** A socket dies, a deadline passes, a gateway returns 502 — in
 * all three the provider may have applied the change, or may not have. The only
 * safe behaviour on retry is to look first and adopt what is there.
 *
 * So the assertion is not "the resolver returns success". It is:
 *
 * 1. A retry after an ambiguous failure produces **one** resource, not two.
 * 2. It issues no second create once a first one has landed.
 * 3. It never reports `replace`, because recovering from a lost response must
 *    not destroy anything.
 *
 * Point 2 is conditional, and the condition matters. The faults split into two
 * kinds, and conflating them produces a test that fails on correct behaviour:
 *
 * - `network-error`, `timeout` and `server-error` abort *before* the provider
 *   sees the write. Nothing was applied, so a retry that creates the resource
 *   is exactly right — demanding `adopt` there would be demanding the resolver
 *   adopt something that does not exist.
 * - `truncated-body` and `malformed-body` let the real call through and corrupt
 *   only the *response*. The provider applied the write; the client never
 *   learned. This is the case that catches duplication, and the retry must read
 *   first and adopt.
 *
 * The suite tells them apart by observing whether the create actually landed,
 * rather than by assuming which faults do what — so a transport that changes
 * when a fault fires cannot silently weaken the check.
 *
 * A resolver that POSTs to a collection endpoint and lets the provider mint an
 * id cannot satisfy (1) at all, which is precisely why
 * `vercel.edge-function/v1` and `aws.api-gateway/v1` ship no resolver rather
 * than a convergent-looking one.
 *
 * ## Why this returns results instead of asserting
 *
 * This module is library source, not a test file, so it stays free of any test
 * framework. It runs the scenarios and hands back what happened; the caller
 * asserts in whatever runner it uses. That also means a failure is reported
 * with the provider and fault named, rather than as a bare assertion deep
 * inside a shared helper.
 */
import type { HttpTransport } from "@hobo/core";

import { type ChaosFault, chaosTransport } from "./chaos.js";

/**
 * The faults that leave a write ambiguous. `rate-limited` is deliberately
 * excluded: a 429 means the provider refused the request, so nothing was
 * applied and there is no ambiguity to converge out of.
 */
export const AMBIGUOUS_FAULTS: readonly ChaosFault[] = Object.freeze([
	"network-error",
	"timeout",
	"server-error",
	"truncated-body",
	"malformed-body",
]);

/** One resolver under test, wired to whatever transport the suite supplies. */
export interface ChaosSubject {
	/** Names the provider and product in failure output. */
	readonly label: string;
	/**
	 * Builds a fresh world and a resolver for it, called once per scenario so no
	 * state leaks between faults.
	 *
	 * The subject owns its fake provider transport — only it knows that API's
	 * shape — and passes that transport through `wrap` before binding the
	 * resolver to the result. Inverting it (suite supplies the transport) cannot
	 * work: the wrapper has to sit around a fake the subject has not built yet.
	 */
	readonly create: (
		wrap: (inner: HttpTransport) => HttpTransport,
	) => ChaosSubjectRun;
}

export interface ChaosSubjectRun {
	/** Reconciles once. May reject; the suite treats a rejection as the fault landing. */
	readonly reconcile: () => Promise<{
		readonly physicalId?: string;
		readonly action?: string;
	}>;
	/** How many resources exist in the fake world right now. */
	readonly countResources: () => number;
	/** How many create-shaped calls the transport has seen. */
	readonly countCreates: () => number;
}

export interface ChaosScenarioResult {
	readonly label: string;
	readonly fault: ChaosFault;
	/** Did the first (faulted) reconcile reject, or return despite the fault? */
	readonly firstRejected: boolean;
	/**
	 * Did the create reach the provider before the fault fired? This is what
	 * separates "nothing was applied, so create again" from "it was applied and
	 * you did not hear about it, so adopt".
	 */
	readonly writeLandedFirstAttempt: boolean;
	readonly resourcesAfterRetry: number;
	readonly createsAfterRetry: number;
	readonly physicalIdStable: boolean;
	readonly retryAction: string | undefined;
	/** Every way this scenario violated the convergence property. */
	readonly violations: readonly string[];
}

/**
 * Drives one subject through every ambiguous fault, injecting each on the call
 * that writes.
 *
 * `writeCallIndex` is which transport call performs the create — resolvers read
 * before they write, so it is rarely 0, and injecting on the read would test
 * something else entirely (a failed read is unambiguous: nothing was applied).
 */
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
	// The fault fires once, on the write. The retry runs against a clean
	// transport so the second attempt is not itself sabotaged — the question is
	// whether the resolver recovers, not whether it survives a second hit.
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

/** Every violation across a run, formatted for one assertion. */
export function chaosViolations(
	results: readonly ChaosScenarioResult[],
): readonly string[] {
	return results.flatMap((result) =>
		result.violations.map(
			(violation) => `${result.label} [${result.fault}]: ${violation}`,
		),
	);
}
