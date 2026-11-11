import {
	CI_FABRIC_SCHEMA,
	type CiFabricContract,
	CiFabricContractError,
	REQUIRED_PR_CHECKS,
} from "./contract.js";
import type { WorkflowFile } from "./workflows.js";

const FORBIDDEN_CLOUD_ACTION_PREFIXES = [
	"iam:",
	"billing:",
	"secrets:",
	"resources:admin",
] as const;
const SECRET_REFERENCE_PATTERN = /\$\{\{\s*secrets\./i;

export interface ContractViolation {
	readonly code: string;
	readonly message: string;
}

export interface ValidationReport {
	readonly passed: boolean;
	readonly coverage: readonly string[];
	readonly violations: readonly ContractViolation[];
}

const REQUIRED_COVERAGE = [
	"pr.full-suite-blocking",
	"e2e.oidc-secretless",
	"e2e.hello-bindle-live-url",
	"e2e.teardown-and-sweeper",
	"e2e.cost-gated",
	"e2e.quarantine-nonblocking",
	"cache.wasm-oci-artifacts",
] as const;

export function validateCiFabricContract(
	contract: CiFabricContract,
	workflows: readonly WorkflowFile[] | null,
): ValidationReport {
	const violations: ContractViolation[] = [];

	if (contract.schema !== CI_FABRIC_SCHEMA) {
		violations.push({
			code: "schema.unsupported",
			message: `expected schema ${CI_FABRIC_SCHEMA}`,
		});
	}

	validateDeclaredContract(contract, violations);
	if (workflows !== null) {
		validateWorkflowFiles(contract, workflows, violations);
	}

	return {
		passed: violations.length === 0,
		coverage: violations.length === 0 ? [...REQUIRED_COVERAGE] : [],
		violations,
	};
}

export function assertCiFabricContract(
	contract: CiFabricContract,
	workflows: readonly WorkflowFile[],
): ValidationReport {
	const report = validateCiFabricContract(contract, workflows);
	if (!report.passed) {
		throw new CiFabricContractError(
			"ci-fabric-contract-failed",
			report.violations
				.map((violation) => `${violation.code}: ${violation.message}`)
				.join("; "),
			{ violations: report.violations },
		);
	}
	return report;
}

function validateDeclaredContract(
	contract: CiFabricContract,
	violations: ContractViolation[],
): void {
	const pullRequestGate = contract.workflow.pullRequestGate;
	if (pullRequestGate.blocksPullRequest !== true) {
		violations.push({
			code: "pr-gate.not-blocking",
			message: "pull request gate must block on failure",
		});
	}

	const checks = new Set(pullRequestGate.requiredChecks);
	const missingChecks = REQUIRED_PR_CHECKS.filter(
		(check) => !checks.has(check),
	);
	if (missingChecks.length > 0) {
		violations.push({
			code: "pr-gate.missing-checks",
			message: `PR gate is missing required checks: ${missingChecks.join(", ")}`,
		});
	}

	const cacheKinds = new Set(
		contract.workflow.artifactCache.entries.map((entry) => entry.kind),
	);
	if (!cacheKinds.has("wasm")) {
		violations.push({
			code: "cache.wasm.missing",
			message: "CI cache must include wasm build artifacts",
		});
	}
	if (!cacheKinds.has("oci")) {
		violations.push({
			code: "cache.oci.missing",
			message: "CI cache must include OCI build artifacts",
		});
	}

	validateE2eContract(
		contract.e2e,
		contract.workflow.triggers.schedule,
		violations,
	);
}

function validateE2eContract(
	e2e: CiFabricContract["e2e"],
	scheduleCron: string,
	violations: ContractViolation[],
): void {
	const gatedBy = e2e.gatedBy;
	const hasLabelGate = gatedBy.some(
		(gate) => gate.kind === "pull-request-label" && gate.label,
	);
	const hasScheduleGate = gatedBy.some(
		(gate) => gate.kind === "schedule" && gate.cron,
	);
	const hasManualGate = gatedBy.some((gate) => gate.kind === "manual");

	if (
		!hasLabelGate ||
		!hasScheduleGate ||
		!hasManualGate ||
		scheduleCron !== "17 3 * * 1"
	) {
		violations.push({
			code: "e2e.cost-gate.missing",
			message:
				"hello-bindle E2E must be gated by PR label, schedule, and manual dispatch",
		});
	}

	if (
		e2e.permissions["id-token"] !== "write" ||
		e2e.auth.mode !== "oidc-federation"
	) {
		violations.push({
			code: "oidc.missing",
			message:
				"E2E job must request a GitHub OIDC token for sandbox federation",
		});
	}

	if (e2e.auth.forbidsStoredSecrets !== true) {
		violations.push({
			code: "oidc.secretless-required",
			message: "E2E auth must forbid stored cloud secrets",
		});
	}

	const secretEnvKeys = Object.entries(e2e.env)
		.filter(
			([key, value]) =>
				key.includes("SECRET") || SECRET_REFERENCE_PATTERN.test(String(value)),
		)
		.map(([key]) => key)
		.sort();
	if (secretEnvKeys.length > 0) {
		violations.push({
			code: "oidc.stored-secret",
			message: `E2E environment references stored secrets: ${secretEnvKeys.join(", ")}`,
		});
	}

	const actions = e2e.auth.cloudRole.allowedActions;
	const overbroadActions = actions.filter(isOverbroadCloudAction);
	if (overbroadActions.length > 0) {
		violations.push({
			code: "oidc.role.overbroad",
			message: `sandbox role grants forbidden or wildcard actions: ${overbroadActions.join(", ")}`,
		});
	}

	const asserts = new Set(e2e.deploy.asserts);
	if (
		e2e.fixture !== "examples/hello-bindle" ||
		!e2e.deploy.command.includes("hello-bindle")
	) {
		violations.push({
			code: "e2e.fixture.missing",
			message: "E2E job must deploy examples/hello-bindle",
		});
	}
	if (!asserts.has("live-url.https") || !asserts.has("live-url.http-2xx")) {
		violations.push({
			code: "e2e.live-url-assertion.missing",
			message: "E2E job must assert an HTTPS live URL returning HTTP 2xx",
		});
	}

	if (e2e.teardown.always !== true) {
		violations.push({
			code: "e2e.teardown.not-always",
			message: "hello-bindle teardown must run with if: always() semantics",
		});
	}
	if (e2e.teardown.orphanSweeper.enabled !== true) {
		violations.push({
			code: "e2e.orphan-sweeper.missing",
			message:
				"hello-bindle E2E must include an orphan sweeper for failed runs",
		});
	}

	if (
		e2e.quarantine.continueOnError !== true ||
		e2e.quarantine.blocksPullRequest !== false
	) {
		violations.push({
			code: "e2e.quarantine.blocks",
			message: "quarantine E2E lane must not block PR merges",
		});
	}
}

function validateWorkflowFiles(
	contract: CiFabricContract,
	workflows: readonly WorkflowFile[],
	violations: ContractViolation[],
): void {
	const hoboCi = findWorkflow(workflows, "hobo-ci.yml");
	const examplesE2e = findWorkflow(workflows, "examples-e2e.yml");

	if (!hoboCi) {
		violations.push({
			code: "workflow.hobo-ci.missing",
			message: "missing .github/workflows/hobo-ci.yml",
		});
	}
	if (!examplesE2e) {
		violations.push({
			code: "workflow.examples-e2e.missing",
			message: "missing .github/workflows/examples-e2e.yml",
		});
	}

	if (hoboCi) {
		validateHoboCiWorkflow(hoboCi.content, violations);
	}
	if (examplesE2e) {
		validateExamplesE2eWorkflow(examplesE2e.content, contract, violations);
	}
}

function validateHoboCiWorkflow(
	content: string,
	violations: ContractViolation[],
): void {
	if (!/pr-gate:/u.test(content)) {
		violations.push({
			code: "workflow.pr-gate.missing",
			message: "hobo-ci.yml must define pr-gate job",
		});
	}
	if (!/main-gate:/u.test(content)) {
		violations.push({
			code: "workflow.main-gate.missing",
			message: "hobo-ci.yml must define main-gate job",
		});
	}
	if (!/ci-guard:/u.test(content)) {
		violations.push({
			code: "workflow.ci-guard.missing",
			message: "hobo-ci.yml must define ci-guard job",
		});
	}
	if (!/secret-scan:/u.test(content)) {
		violations.push({
			code: "workflow.secret-scan.missing",
			message: "hobo-ci.yml must define secret-scan job",
		});
	}
	if (!/pnpm agent:check/u.test(content)) {
		violations.push({
			code: "workflow.pr-gate.agent-check",
			message: "pr-gate must run pnpm agent:check with base ref",
		});
	}
	if (
		!/turbo run build typecheck lint/u.test(content) ||
		(!/--affected/u.test(content) &&
			!content.includes("{packages/*}[origin") &&
			!content.includes("--filter=./packages/") &&
			!content.includes("scripts/ci/affected-lanes.mts"))
	) {
		violations.push({
			code: "workflow.pr-gate.affected",
			message:
				"pr-gate must run turbo affected lanes (or production git-range impact filter)",
		});
	}
	// Jobs may be skipped for a signed local run only while the pr-gate still
	// decides: the route job must verify the signature, and the gate must see
	// that the route job itself succeeded before it accepts a skipped job.
	if (/needs\.route\.outputs\.attested/u.test(content)) {
		if (!content.includes("scripts/ci/verify-attestation.mts")) {
			violations.push({
				code: "workflow.pr-gate.attestation-unverified",
				message:
					"jobs are skipped for a signed local run, but the route job does not check out scripts/ci/verify-attestation.mts to verify it",
			});
		}
		if (!content.includes("ROUTE_RESULT: ${{ needs.route.result }}")) {
			violations.push({
				code: "workflow.pr-gate.attestation-route-result",
				message:
					"pr-gate accepts jobs skipped for a signed local run without reading the route job's result",
			});
		}
	}
	for (const check of REQUIRED_PR_CHECKS) {
		if (check === "conformance") {
			if (!/test:contract:consumer/u.test(content)) {
				violations.push({
					code: "workflow.pr-gate.missing-check",
					message: `pr-gate missing conformance lane (test:contract:consumer)`,
				});
			}
		} else if (!content.includes(check)) {
			violations.push({
				code: "workflow.pr-gate.missing-check",
				message: `pr-gate missing required check task: ${check}`,
			});
		}
	}
}

function validateExamplesE2eWorkflow(
	content: string,
	contract: CiFabricContract,
	violations: ContractViolation[],
): void {
	const cloudJobs = extractJobBlocks(content, [
		"hello-bindle-fixture",
		"hello-bindle-fixture-quarantine",
	]);

	if (!cloudJobs.has("hello-bindle-fixture")) {
		violations.push({
			code: "workflow.e2e.job.missing",
			message: "examples-e2e.yml must define hello-bindle-fixture job",
		});
	}
	if (!cloudJobs.has("hello-bindle-fixture-quarantine")) {
		violations.push({
			code: "workflow.e2e.quarantine.missing",
			message:
				"examples-e2e.yml must define hello-bindle-fixture-quarantine job",
		});
	}

	for (const [jobName, jobContent] of cloudJobs) {
		if (!/id-token:\s*write/u.test(jobContent)) {
			violations.push({
				code: "oidc.missing",
				message: `${jobName} must request id-token: write`,
			});
		}

		if (SECRET_REFERENCE_PATTERN.test(jobContent)) {
			violations.push({
				code: "oidc.stored-secret",
				message: `${jobName} references stored secrets via \${{ secrets.* }}`,
			});
		}

		if (jobName === "hello-bindle-fixture") {
			if (
				!/'hobo\/e2e'/u.test(jobContent) &&
				!/"hobo\/e2e"/u.test(jobContent)
			) {
				violations.push({
					code: "e2e.cost-gate.missing",
					message: "hello-bindle-fixture must gate on hobo/e2e label",
				});
			}
			if (!/if:\s*always\(\)/u.test(jobContent)) {
				violations.push({
					code: "e2e.teardown.not-always",
					message:
						"hello-bindle-fixture teardown/sweep steps must use if: always()",
				});
			}
		}

		if (jobName === "hello-bindle-fixture-quarantine") {
			if (!/continue-on-error:\s*true/u.test(jobContent)) {
				violations.push({
					code: "e2e.quarantine.blocks",
					message:
						"hello-bindle-fixture-quarantine must set continue-on-error: true",
				});
			}
			if (!jobContent.includes(contract.e2e.quarantine.label)) {
				violations.push({
					code: "e2e.quarantine.label",
					message: `quarantine job must gate on ${contract.e2e.quarantine.label}`,
				});
			}
		}
	}

	if (!/sweep-orphans/u.test(content)) {
		violations.push({
			code: "e2e.orphan-sweeper.missing",
			message: "examples-e2e.yml must include sweep-orphans phase",
		});
	}
}

function findWorkflow(
	workflows: readonly WorkflowFile[],
	name: string,
): WorkflowFile | undefined {
	return workflows.find((file) => file.name === name);
}

function extractJobBlocks(
	content: string,
	jobNames: readonly string[],
): Map<string, string> {
	const lines = content.split("\n");
	const blocks = new Map<string, string>();

	for (const jobName of jobNames) {
		const start = lines.indexOf(`  ${jobName}:`);
		if (start === -1) {
			continue;
		}

		let end = lines.length;
		for (let index = start + 1; index < lines.length; index += 1) {
			const line = lines[index];
			if (line && /^ {2}[a-z0-9-]+:$/u.test(line)) {
				end = index;
				break;
			}
		}

		blocks.set(jobName, lines.slice(start, end).join("\n"));
	}

	return blocks;
}

function isOverbroadCloudAction(action: string): boolean {
	return (
		action.includes("*") ||
		FORBIDDEN_CLOUD_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix))
	);
}

export function shouldRunHelloBindleE2e(
	contract: CiFabricContract,
	{
		eventName,
		labels = [],
	}: { eventName?: string; labels?: readonly string[] } = {},
): boolean {
	const gatedBy = contract.e2e.gatedBy;
	const labelSet = new Set(labels);

	return gatedBy.some((gate) => {
		if (gate.kind === "schedule") {
			return eventName === "schedule";
		}
		if (gate.kind === "manual") {
			return eventName === "workflow_dispatch";
		}
		if (gate.kind === "pull-request-label" && gate.label) {
			return eventName === "pull_request" && labelSet.has(gate.label);
		}
		return false;
	});
}

export interface SimulationEvent {
	readonly type: string;
	readonly audience?: string;
	readonly subject?: string;
	readonly role?: string;
	readonly scopes?: readonly string[];
	readonly fixture?: string;
	readonly runId?: string;
	readonly liveUrl?: string;
	readonly ok?: boolean;
	readonly selector?: string;
	readonly maxAgeMinutes?: number;
}

export interface HelloBindleSimulation {
	readonly status: "passed" | "failed";
	readonly failure?: { readonly code: string; readonly message: string };
	readonly token: {
		readonly issuer: string;
		readonly audience: string;
		readonly subject: string;
		readonly scopes: readonly string[];
		readonly expiresInSeconds: number;
	};
	readonly deployment: {
		readonly fixture: string;
		readonly runId: string;
		readonly liveUrl: string;
	};
	readonly cleanup: {
		readonly teardownAttempted: boolean;
		readonly orphanSweeperRan: boolean;
	};
	readonly events: readonly SimulationEvent[];
}

export function simulateHelloBindleE2e(
	contract: CiFabricContract,
	{
		githubRunId,
		liveUrl,
		failAt,
	}: { githubRunId?: string; liveUrl?: string; failAt?: string } = {},
): HelloBindleSimulation {
	const report = validateCiFabricContract(contract, null);
	if (!report.passed) {
		throw new CiFabricContractError(
			"ci-fabric-contract-failed",
			report.violations.map((v) => v.message).join("; "),
			{ violations: report.violations },
		);
	}

	const runId = githubRunId ?? "local-run";
	const e2e = contract.e2e;
	const events: SimulationEvent[] = [];
	const token = {
		issuer: e2e.auth.tokenBroker,
		audience: e2e.auth.audience,
		subject: e2e.auth.allowedTrustDomain,
		scopes: [...e2e.auth.cloudRole.allowedActions],
		expiresInSeconds: 900,
	};
	const deployment = {
		fixture: e2e.fixture,
		runId,
		liveUrl: liveUrl ?? `https://hello-bindle.${runId}.sandbox.hobo.dev`,
	};

	events.push({
		type: "oidc.TokenRequested",
		audience: token.audience,
		subject: token.subject,
	});
	events.push({
		type: "sandbox.TokenGranted",
		role: e2e.auth.cloudRole.name,
		scopes: [...token.scopes],
	});
	events.push({ type: "hobo.UpStarted", fixture: deployment.fixture, runId });
	events.push({
		type: "hobo.LiveUrlAsserted",
		liveUrl: deployment.liveUrl,
		ok: failAt !== "assert-live-url",
	});

	let failure: { code: string; message: string } | undefined;
	if (failAt === "assert-live-url") {
		failure = {
			code: "live-url-unreachable",
			message: `${deployment.liveUrl} did not return HTTP 2xx`,
		};
	}

	events.push({ type: "hobo.DownStarted", fixture: deployment.fixture, runId });
	events.push({
		type: "hobo.OrphanSweepCompleted",
		selector: e2e.teardown.orphanSweeper.selector,
		maxAgeMinutes: e2e.teardown.orphanSweeper.maxAgeMinutes,
	});

	const cleanup = { teardownAttempted: true, orphanSweeperRan: true };
	if (failure !== undefined) {
		return {
			status: "failed",
			failure,
			token,
			deployment,
			cleanup,
			events,
		};
	}
	return {
		status: "passed",
		token,
		deployment,
		cleanup,
		events,
	};
}
