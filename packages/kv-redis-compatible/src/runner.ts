/**
 * The conformance runner.
 *
 * Three properties matter here, and they are all about not lying:
 *
 * 1. A case that could not run is `skipped`, never `pass`. A missing time
 *    control or an undeclared payload bound reduces what the run establishes;
 *    it never increases it.
 * 2. A run with any skipped required case reports `incomplete`, and
 *    `incomplete` maps to `unknown` conformance, which selection fails closed on.
 * 3. A structured capability is only reported as substantiated when every case
 *    that substantiates it passed. One passing case out of two does not
 *    establish a capability.
 */
import type { ProfileImplementation } from "@hobo/capability-profiles";

import {
	type ConformanceArea,
	type ConformanceCase,
	KV_REDIS_CONFORMANCE_CASES,
} from "./cases.js";
import { KvRedisCompatibleError } from "./errors.js";
import {
	describeCommand,
	evaluateExpectation,
	type FillSizes,
	type KvRedisExecutor,
	type RedisReply,
	requiredFills,
	resolveCommand,
	resolveFillSizes,
} from "./protocol.js";

// public-contract: suite id recorded on every report a catalog reads.
export const KV_REDIS_CONFORMANCE_SUITE_REF =
	"conformance.kv.redis-compatible/v1" as const;

/** How the executor reaches the implementation. Substantiates `restTransport`. */
export const TRANSPORT_KINDS = ["rest", "resp", "in-process"] as const;

export type TransportKind = (typeof TRANSPORT_KINDS)[number];

export type DeclaredLimits = {
	/**
	 * The implementation's documented maximum value size. Undeclared means the
	 * bounded-payload cases cannot run, not that the store is unbounded.
	 */
	readonly maxValueBytes?: number;
};

export type ConformanceRunInput = {
	readonly executor: KvRedisExecutor;
	readonly transport: TransportKind;
	readonly cases?: readonly ConformanceCase[];
	readonly limits?: DeclaredLimits;
	/** Prefix applied to every `hobo:conf:` key so a live run cannot collide. */
	readonly keyPrefix?: string;
	readonly suiteRef?: string;
};

// parallel-type-allowed: the in-process result keeps `outcome` as a closed "pass" | "fail" union the fold switches on; the proto StepResult is its recorded wire projection.
export type StepResult = {
	readonly command: string;
	readonly outcome: "pass" | "fail";
	readonly detail: string;
};

// parallel-type-allowed: the in-process result reuses `ConformanceCase["profileId"]`, so a case and its result cannot drift apart; the proto ConformanceCaseResult is its wire projection.
export type ConformanceCaseResult = {
	readonly caseId: string;
	readonly area: ConformanceArea;
	readonly profileId: ConformanceCase["profileId"];
	readonly outcome: "pass" | "fail" | "skipped";
	readonly reason: string;
	readonly steps: readonly StepResult[];
};

// parallel-type-allowed: the in-process report types `transport` as the closed TransportKind union the runner switches on to substantiate restTransport; the proto ConformanceReport is its recorded wire projection.
export type ConformanceReport = {
	readonly suiteRef: string;
	readonly transport: TransportKind;
	/**
	 * `pass` only when every required case passed. `incomplete` when a required
	 * case could not run. `fail` when one actually failed.
	 */
	readonly outcome: "pass" | "fail" | "incomplete";
	readonly results: readonly ConformanceCaseResult[];
	/** Capability keys every substantiating case passed for. */
	readonly substantiatedCapabilities: readonly string[];
	readonly failedCaseIds: readonly string[];
	readonly skippedCaseIds: readonly string[];
};

const KEY_PREFIX_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,63}$/u;

function assertKeyPrefix(prefix: string): void {
	if (prefix === "") return;
	if (!KEY_PREFIX_PATTERN.test(prefix)) {
		throw new KvRedisCompatibleError(
			"INVALID_CONFORMANCE_CASE",
			"key prefix must be a short lowercase identifier so a conformance run cannot address arbitrary keys",
		);
	}
}

function skip(
	testCase: ConformanceCase,
	reason: string,
): ConformanceCaseResult {
	return {
		caseId: testCase.id,
		area: testCase.area,
		profileId: testCase.profileId,
		outcome: "skipped",
		reason,
		steps: [],
	};
}

function canRun(
	testCase: ConformanceCase,
	fills: FillSizes,
	executor: KvRedisExecutor,
): string | undefined {
	for (const step of testCase.steps) {
		for (const fill of requiredFills(step.command)) {
			if (fills[fill] === undefined) {
				return "the implementation declares no maximum value size, so a bounded-payload case cannot be constructed";
			}
		}
		if (step.waitMs !== undefined && executor.advanceTime === undefined) {
			return "the executor exposes no time control, so expiry cannot be observed without guessing";
		}
	}
	return undefined;
}

async function runCase(
	testCase: ConformanceCase,
	input: {
		readonly executor: KvRedisExecutor;
		readonly fills: FillSizes;
		readonly keyPrefix: string;
	},
): Promise<ConformanceCaseResult> {
	const steps: StepResult[] = [];
	for (const step of testCase.steps) {
		if (step.waitMs !== undefined) {
			// `canRun` already established the control exists.
			// SAFETY: `await (input.executor.advanceTime as (ms: number) => Promise<void>)(` is required at this I/O or test boundary.
			await (input.executor.advanceTime as (ms: number) => Promise<void>)(
				step.waitMs,
			);
		}
		const command = resolveCommand(step.command, {
			keyPrefix: input.keyPrefix,
			fills: input.fills,
		});
		let reply: RedisReply;
		try {
			reply = await input.executor.execute(command);
		} catch (cause) {
			// A thrown executor is a harness or transport failure, not an error
			// reply. Conflating the two would let a broken transport "pass" a
			// case whose expectation is `error`.
			throw new KvRedisCompatibleError(
				"CONFORMANCE_EXECUTOR_FAILED",
				`the executor threw while running ${testCase.id}; an implementation error must be returned as an error reply, not thrown`,
				{ cause },
			);
		}
		const outcome = evaluateExpectation(step.expect, reply, input.fills);
		steps.push({
			command: describeCommand(command),
			outcome: outcome.ok ? "pass" : "fail",
			detail: outcome.detail,
		});
		if (!outcome.ok) {
			return {
				caseId: testCase.id,
				area: testCase.area,
				profileId: testCase.profileId,
				outcome: "fail",
				reason: outcome.detail,
				steps,
			};
		}
	}
	return {
		caseId: testCase.id,
		area: testCase.area,
		profileId: testCase.profileId,
		outcome: "pass",
		reason: "every step matched",
		steps,
	};
}

function substantiated(
	cases: readonly ConformanceCase[],
	results: readonly ConformanceCaseResult[],
	transport: TransportKind,
): readonly string[] {
	const outcomeById = new Map(
		results.map((result) => [result.caseId, result.outcome]),
	);
	const required = new Map<string, boolean>();
	for (const testCase of cases) {
		const outcome = outcomeById.get(testCase.id);
		for (const capability of testCase.substantiates) {
			const already = required.get(capability) ?? true;
			required.set(capability, already && outcome === "pass");
		}
	}
	const keys = [...required.entries()]
		.filter(([, allPassed]) => allPassed)
		.map(([capability]) => capability);
	// `restTransport` is a property of how the run reached the store, not of
	// any single command, so it is the one capability the cases cannot assert.
	if (
		transport === "rest" &&
		results.every((result) => result.outcome !== "fail")
	) {
		keys.push("restTransport");
	}
	return [...new Set(keys)].sort((a, b) => a.localeCompare(b));
}

export async function runKvRedisConformance(
	input: ConformanceRunInput,
): Promise<ConformanceReport> {
	const cases = input.cases ?? KV_REDIS_CONFORMANCE_CASES;
	const keyPrefix = input.keyPrefix ?? "";
	assertKeyPrefix(keyPrefix);
	const fills = resolveFillSizes(input.limits?.maxValueBytes);

	const results: ConformanceCaseResult[] = [];
	for (const testCase of [...cases].sort((a, b) => a.id.localeCompare(b.id))) {
		const blocker = canRun(testCase, fills, input.executor);
		results.push(
			blocker !== undefined
				? skip(testCase, blocker)
				: await runCase(testCase, {
						executor: input.executor,
						fills,
						keyPrefix,
					}),
		);
	}

	const optional = new Set(
		cases.filter((entry) => entry.optional === true).map((e) => e.id),
	);
	const failedCaseIds = results
		.filter((result) => result.outcome === "fail")
		.map((result) => result.caseId);
	const skippedCaseIds = results
		.filter(
			(result) => result.outcome === "skipped" && !optional.has(result.caseId),
		)
		.map((result) => result.caseId);

	const outcome: ConformanceReport["outcome"] =
		failedCaseIds.length > 0
			? "fail"
			: skippedCaseIds.length > 0
				? "incomplete"
				: "pass";

	return {
		suiteRef: input.suiteRef ?? KV_REDIS_CONFORMANCE_SUITE_REF,
		transport: input.transport,
		outcome,
		results,
		substantiatedCapabilities: substantiated(cases, results, input.transport),
		failedCaseIds,
		skippedCaseIds,
	};
}

/**
 * Turn a report into the profile implementations a product may declare.
 *
 * `incomplete` becomes `unknown` rather than `pass`, and selection treats
 * `unknown` as a hard rejection. That is the intended cost of an incomplete run.
 */
export function toProfileImplementations(
	report: ConformanceReport,
	options: { readonly conformanceRef: string },
): readonly ProfileImplementation[] {
	const conformance: ProfileImplementation["conformance"] =
		report.outcome === "pass"
			? "pass"
			: report.outcome === "fail"
				? "fail"
				: "unknown";
	return [
		{
			profileId: "kv.key-value/v1",
			versionRange: ">=1",
			realization: "native",
			conformanceRef: options.conformanceRef,
			conformance,
		},
		{
			profileId: "kv.redis-compatible/v1",
			versionRange: ">=1",
			realization: "native",
			conformanceRef: options.conformanceRef,
			conformance,
		},
	];
}

/**
 * Structured capabilities a product may advertise on the strength of a run.
 *
 * Anything the run did not substantiate is left out entirely rather than set
 * to `false`, because absent fails a required-feature gate while `false` also
 * fails it — and absent is the honest statement of "not established here".
 *
 * `maxValueBytes` is the one numeric key: the bounded-payload cases prove the
 * declared limit is real, so the number is emitted rather than a flag.
 */
export function toStructuredCapabilities(
	report: ConformanceReport,
	options: { readonly limits?: DeclaredLimits } = {},
): Readonly<Record<string, boolean | number>> {
	const capabilities: Record<string, boolean | number> = {};
	for (const capability of report.substantiatedCapabilities) {
		if (capability === "maxValueBytes") {
			const declared = options.limits?.maxValueBytes;
			if (declared !== undefined) capabilities[capability] = declared;
			continue;
		}
		capabilities[capability] = true;
	}
	return Object.freeze(capabilities);
}
