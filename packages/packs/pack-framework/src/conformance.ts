/**
 * The shared conformance harness: declarative cases plus an injected executor.
 *
 * A conformance case is data — a list of steps, each of which is an argv array,
 * a TCP connect, an HTTP GET, or a workload restart. Nothing in this module can
 * start a container, open a socket, or read a clock. That is what lets the
 * default test lane stay offline: the same cases run against a replay runner
 * built from recorded outcomes, and the opt-in container lane supplies a runner
 * that really talks to a container runtime.
 *
 * Cases declare what they need. A case whose evidence genuinely requires a live
 * container is marked `requires: "container-runtime"`, and
 * {@link offlineCases} filters those out so a default run never depends on
 * Docker being installed.
 */
import { containsControlChar } from "./argv.js";
import { PackError } from "./errors.js";
import type { VerifiedPackManifest } from "./verification.js";

export type PackConformanceStep =
	| {
			readonly kind: "exec";
			readonly argv: readonly string[];
			readonly expectExitCode: number;
			readonly expectStdoutContains?: string;
	  }
	| {
			readonly kind: "tcp-connect";
			readonly portName: string;
			readonly expectReachable: boolean;
	  }
	| {
			readonly kind: "http-get";
			readonly portName: string;
			readonly path: string;
			readonly expectStatus: number;
	  }
	| { readonly kind: "restart-workload"; readonly reason: string };

export type PackConformanceRequirement = "none" | "container-runtime";

export type PackConformanceCase = {
	readonly id: string;
	/** The capability profile (or guarantee) this case is evidence for. */
	readonly profileRef: string;
	readonly description: string;
	readonly requires: PackConformanceRequirement;
	readonly steps: readonly PackConformanceStep[];
};

export type PackConformanceStepOutcome = {
	readonly ok: boolean;
	readonly exitCode?: number;
	readonly stdout?: string;
	readonly status?: number;
	readonly reachable?: boolean;
	readonly detail?: string;
};

export type PackConformanceRunRequest = {
	readonly manifest: VerifiedPackManifest;
	readonly caseId: string;
	readonly stepIndex: number;
	readonly step: PackConformanceStep;
};

/**
 * Implementations MUST NOT interpret an `exec` step through a shell and MUST
 * treat an unreachable runtime as a failed step rather than a skipped one.
 */
export interface PackConformanceRunner {
	run(request: PackConformanceRunRequest): Promise<PackConformanceStepOutcome>;
}

export type PackConformanceCaseResult = {
	readonly caseId: string;
	readonly profileRef: string;
	readonly outcome: "pass" | "fail";
	readonly failedStepIndex?: number;
	readonly detail?: string;
};

export type PackConformanceReport = {
	readonly packId: string;
	readonly packVersion: string;
	readonly architecture: string;
	readonly imageDigest: string;
	readonly outcome: "pass" | "fail";
	readonly results: readonly PackConformanceCaseResult[];
};

const CASE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;

/**
 * Parse-don't-validate boundary for a case list.
 *
 * Runs before anything is executed, so a malformed case is a load-time failure
 * rather than a half-finished conformance run.
 */
export function parseConformanceCases(
	cases: readonly PackConformanceCase[],
	manifest: VerifiedPackManifest,
): readonly PackConformanceCase[] {
	if (cases.length === 0) {
		throw new PackError(
			"PACK_CONFORMANCE_FAILED",
			"a conformance suite with no cases proves nothing and is rejected rather than reported as a pass",
		);
	}
	const ids = new Set<string>();
	for (const testCase of cases) {
		if (!CASE_ID.test(testCase.id)) {
			throw new PackError(
				"PACK_CONFORMANCE_FAILED",
				`conformance case id ${JSON.stringify(testCase.id)} must be lowercase dot/dash separated`,
			);
		}
		if (ids.has(testCase.id)) {
			throw new PackError(
				"PACK_CONFORMANCE_FAILED",
				`duplicate conformance case id ${testCase.id}`,
			);
		}
		ids.add(testCase.id);
		if (testCase.steps.length === 0) {
			throw new PackError(
				"PACK_CONFORMANCE_FAILED",
				`conformance case ${testCase.id} declares no steps`,
			);
		}
		for (const step of testCase.steps) {
			if (step.kind === "exec") {
				if (step.argv.length === 0) {
					throw new PackError(
						"PACK_CONFORMANCE_FAILED",
						`conformance case ${testCase.id} has an empty argv array`,
					);
				}
				for (const element of step.argv) {
					if (element.length === 0 || containsControlChar(element)) {
						throw new PackError(
							"PACK_CONFORMANCE_FAILED",
							`conformance case ${testCase.id} argv elements must be non-empty and free of control characters`,
						);
					}
				}
			} else if (step.kind === "tcp-connect" || step.kind === "http-get") {
				if (!manifest.ports.some((port) => port.name === step.portName)) {
					throw new PackError(
						"PACK_CONFORMANCE_FAILED",
						`conformance case ${testCase.id} references port ${JSON.stringify(step.portName)}, which pack ${manifest.packId} does not declare`,
					);
				}
			}
		}
	}
	return [...cases].sort((a, b) => a.id.localeCompare(b.id));
}

/** Cases that can be evidenced without a container runtime. */
export function offlineCases(
	cases: readonly PackConformanceCase[],
): readonly PackConformanceCase[] {
	return cases.filter((testCase) => testCase.requires === "none");
}

/** Cases that only mean anything against a real container. */
export function containerCases(
	cases: readonly PackConformanceCase[],
): readonly PackConformanceCase[] {
	return cases.filter((testCase) => testCase.requires === "container-runtime");
}

interface StepVerdict {
	readonly ok: boolean;
	readonly detail?: string;
}

function stepSatisfied(
	step: PackConformanceStep,
	outcome: PackConformanceStepOutcome,
): StepVerdict {
	if (!outcome.ok) {
		return {
			ok: false,
			detail: outcome.detail ?? "runner reported the step as failed",
		};
	}
	switch (step.kind) {
		case "exec": {
			if (outcome.exitCode !== step.expectExitCode) {
				return {
					ok: false,
					detail: `expected exit code ${step.expectExitCode}, observed ${String(outcome.exitCode)}`,
				};
			}
			if (
				step.expectStdoutContains !== undefined &&
				!(outcome.stdout ?? "").includes(step.expectStdoutContains)
			) {
				return {
					ok: false,
					detail: "stdout did not contain the expected marker",
				};
			}
			return { ok: true };
		}
		case "tcp-connect": {
			return outcome.reachable === step.expectReachable
				? { ok: true }
				: {
						ok: false,
						detail: `expected reachable=${String(step.expectReachable)}`,
					};
		}
		case "http-get": {
			return outcome.status === step.expectStatus
				? { ok: true }
				: {
						ok: false,
						detail: `expected status ${step.expectStatus}, observed ${String(outcome.status)}`,
					};
		}
		case "restart-workload":
			return { ok: true };
		default: {
			const exhaustive: never = step;
			return { ok: false, detail: `unknown step ${String(exhaustive)}` };
		}
	}
}

/**
 * Run a case list through an injected runner.
 *
 * A case stops at its first failing step: subsequent steps in the same case
 * usually depend on it, and reporting cascade failures as independent findings
 * makes a single defect look like five.
 */
export async function runPackConformance(input: {
	readonly manifest: VerifiedPackManifest;
	readonly cases: readonly PackConformanceCase[];
	readonly runner: PackConformanceRunner;
}): Promise<PackConformanceReport> {
	const { manifest, runner } = input;
	const cases = parseConformanceCases(input.cases, manifest);
	const results: PackConformanceCaseResult[] = [];

	for (const testCase of cases) {
		let failure:
			| { readonly index: number; readonly detail: string }
			| undefined;
		for (const [stepIndex, step] of testCase.steps.entries()) {
			const outcome = await runner.run({
				manifest,
				caseId: testCase.id,
				stepIndex,
				step,
			});
			const verdict = stepSatisfied(step, outcome);
			if (!verdict.ok) {
				failure = {
					index: stepIndex,
					detail: verdict.detail ?? "step did not satisfy expectation",
				};
				break;
			}
		}
		results.push({
			caseId: testCase.id,
			profileRef: testCase.profileRef,
			outcome: failure === undefined ? "pass" : "fail",
			...(failure !== undefined
				? { failedStepIndex: failure.index, detail: failure.detail }
				: undefined),
		});
	}

	return {
		packId: manifest.packId,
		packVersion: manifest.packVersion,
		architecture: manifest.selectedArchitecture,
		imageDigest: manifest.selectedImage.digest,
		outcome: results.every((result) => result.outcome === "pass")
			? "pass"
			: "fail",
		results,
	};
}

export type RecordedStepOutcome = {
	readonly caseId: string;
	readonly stepIndex: number;
	readonly outcome: PackConformanceStepOutcome;
};

/**
 * A runner backed by recorded outcomes.
 *
 * This is what keeps the mandatory lane offline and deterministic. An
 * unrecorded step is an error, not an implicit pass — a fixture set that has
 * drifted from its cases should fail loudly.
 */
export function createReplayConformanceRunner(
	recorded: readonly RecordedStepOutcome[],
): PackConformanceRunner {
	const byKey = new Map(
		recorded.map((entry) => [
			`${entry.caseId}#${entry.stepIndex}`,
			entry.outcome,
		]),
	);
	return {
		run(request) {
			const outcome = byKey.get(`${request.caseId}#${request.stepIndex}`);
			if (outcome === undefined) {
				return Promise.reject(
					new PackError(
						"PACK_CONFORMANCE_FAILED",
						`no recorded outcome for ${request.caseId} step ${request.stepIndex}`,
					),
				);
			}
			return Promise.resolve(outcome);
		},
	};
}
