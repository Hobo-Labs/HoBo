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

export const TRANSPORT_KINDS = ["rest", "resp", "in-process"] as const;

export type TransportKind = (typeof TRANSPORT_KINDS)[number];

export type DeclaredLimits = {
	readonly maxValueBytes?: number;
};

export type ConformanceRunInput = {
	readonly executor: KvRedisExecutor;
	readonly transport: TransportKind;
	readonly cases?: readonly ConformanceCase[];
	readonly limits?: DeclaredLimits;
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
	readonly outcome: "pass" | "fail" | "incomplete";
	readonly results: readonly ConformanceCaseResult[];
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
