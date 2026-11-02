import { describe, expect, it } from "vitest";

import { createHoboCiFabricContract } from "../src/contract.js";
import {
	assertCiFabricContract,
	shouldRunHelloBindleE2e,
	simulateHelloBindleE2e,
	validateCiFabricContract,
} from "../src/validate.js";
import type { WorkflowFile } from "../src/workflows.js";

const SAMPLE_WORKFLOWS: WorkflowFile[] = [
	{
		name: "hobo-ci.yml",
		path: ".github/workflows/hobo-ci.yml",
		content: `
jobs:
  pr-gate:
    steps:
      - run: pnpm agent:check -- --base=origin/main
      - run: pnpm exec turbo run build typecheck lint test:unit test:schema test:contract:consumer --affected
  main-gate:
    steps:
      - run: pnpm run check:all
  ci-guard:
    steps:
      - run: assert-ci-contract
  secret-scan:
    steps:
      - run: gitleaks git --redact --exit-code 1
`,
	},
	{
		name: "examples-e2e.yml",
		path: ".github/workflows/examples-e2e.yml",
		content: `
jobs:
  hello-bindle-fixture:
    if: contains(github.event.pull_request.labels.*.name, 'hobo/e2e')
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Tear down hello-bindle fixture
        if: always()
        run: teardown
      - name: Sweep orphaned hello-bindle fixtures
        if: always()
        run: sweep-orphans
  hello-bindle-fixture-quarantine:
    if: contains(github.event.pull_request.labels.*.name, 'hobo/e2e-quarantine')
    continue-on-error: true
    permissions:
      contents: read
      id-token: write
`,
	},
];

describe("ci-fabric contract", () => {
	it("PR CI blocks on the full local gate including unit and conformance checks", () => {
		const contract = createHoboCiFabricContract();
		const report = assertCiFabricContract(contract, SAMPLE_WORKFLOWS);

		expect(report.passed).toBe(true);
		expect(report.coverage).toEqual([
			"pr.full-suite-blocking",
			"e2e.oidc-secretless",
			"e2e.hello-bindle-live-url",
			"e2e.teardown-and-sweeper",
			"e2e.cost-gated",
			"e2e.quarantine-nonblocking",
			"cache.wasm-oci-artifacts",
		]);
		expect(contract.workflow.pullRequestGate.requiredChecks).toEqual([
			"build",
			"typecheck",
			"lint",
			"unit",
			"conformance",
		]);
		expect(contract.workflow.pullRequestGate.blocksPullRequest).toBe(true);
	});

	it("hello-bindle E2E uses keyless OIDC, asserts the live URL, and tears down", () => {
		const contract = createHoboCiFabricContract();
		const run = simulateHelloBindleE2e(contract, {
			githubRunId: "run-100",
			liveUrl: "https://hello-bindle.run-100.sandbox.hobo.dev",
		});

		expect(run.status).toBe("passed");
		expect(run.events.map((event) => event.type)).toEqual([
			"oidc.TokenRequested",
			"sandbox.TokenGranted",
			"hobo.UpStarted",
			"hobo.LiveUrlAsserted",
			"hobo.DownStarted",
			"hobo.OrphanSweepCompleted",
		]);
		expect(run.cleanup.teardownAttempted).toBe(true);
		expect(run.cleanup.orphanSweeperRan).toBe(true);
		expect(run.deployment.fixture).toBe("examples/hello-bindle");
		expect(run.deployment.liveUrl).toBe(
			"https://hello-bindle.run-100.sandbox.hobo.dev",
		);
		expect(run.token.scopes).toEqual([
			"deployments:create",
			"deployments:read",
			"deployments:delete",
		]);
	});

	it("cost guard keeps E2E behind a label, schedule, or manual dispatch", () => {
		const contract = createHoboCiFabricContract();

		expect(
			shouldRunHelloBindleE2e(contract, {
				eventName: "pull_request",
				labels: [],
			}),
		).toBe(false);
		expect(
			shouldRunHelloBindleE2e(contract, {
				eventName: "pull_request",
				labels: ["hobo/e2e"],
			}),
		).toBe(true);
		expect(
			shouldRunHelloBindleE2e(contract, { eventName: "schedule", labels: [] }),
		).toBe(true);
		expect(
			shouldRunHelloBindleE2e(contract, {
				eventName: "workflow_dispatch",
				labels: [],
			}),
		).toBe(true);
	});

	it("teardown and orphan sweep run even when the live URL assertion fails", () => {
		const contract = createHoboCiFabricContract();
		const run = simulateHelloBindleE2e(contract, {
			githubRunId: "run-101",
			failAt: "assert-live-url",
		});

		expect(run.status).toBe("failed");
		expect(run.failure?.code).toBe("live-url-unreachable");
		expect(run.cleanup.teardownAttempted).toBe(true);
		expect(run.cleanup.orphanSweeperRan).toBe(true);
	});

	it("OIDC trust fails closed when the sandbox role is over-broad", () => {
		const report = validateCiFabricContract(
			createHoboCiFabricContract({
				e2e: {
					auth: {
						cloudRole: {
							allowedActions: ["deployments:*", "iam:*"],
						},
					},
				},
			}),
			SAMPLE_WORKFLOWS,
		);

		expect(report.passed).toBe(false);
		expect(report.violations).toContainEqual({
			code: "oidc.role.overbroad",
			message:
				"sandbox role grants forbidden or wildcard actions: deployments:*, iam:*",
		});
	});

	it("stored cloud secrets are rejected; CI must use the OIDC token broker", () => {
		const secretPlaceholder = "${{" + " secrets.AWS_SECRET_ACCESS_KEY }}";
		const report = validateCiFabricContract(
			createHoboCiFabricContract({
				e2e: {
					env: {
						AWS_SECRET_ACCESS_KEY: secretPlaceholder,
					},
				},
			}),
			SAMPLE_WORKFLOWS,
		);

		expect(report.passed).toBe(false);
		expect(report.violations).toContainEqual({
			code: "oidc.stored-secret",
			message:
				"E2E environment references stored secrets: AWS_SECRET_ACCESS_KEY",
		});
	});

	it("missing teardown or orphan sweeper fails the E2E contract", () => {
		const report = validateCiFabricContract(
			createHoboCiFabricContract({
				e2e: {
					teardown: {
						always: false,
						orphanSweeper: { enabled: false, maxAgeMinutes: 60, selector: "x" },
					},
				},
			}),
			SAMPLE_WORKFLOWS,
		);

		expect(report.passed).toBe(false);
		expect(report.violations).toEqual(
			expect.arrayContaining([
				{
					code: "e2e.teardown.not-always",
					message: "hello-bindle teardown must run with if: always() semantics",
				},
				{
					code: "e2e.orphan-sweeper.missing",
					message:
						"hello-bindle E2E must include an orphan sweeper for failed runs",
				},
			]),
		);
	});

	it("flaky E2E runs have a non-blocking quarantine lane", () => {
		const report = validateCiFabricContract(
			createHoboCiFabricContract({
				e2e: {
					quarantine: {
						continueOnError: false,
						blocksPullRequest: true,
					},
				},
			}),
			SAMPLE_WORKFLOWS,
		);

		expect(report.passed).toBe(false);
		expect(report.violations).toContainEqual({
			code: "e2e.quarantine.blocks",
			message: "quarantine E2E lane must not block PR merges",
		});
	});

	it("wasm and OCI build artifacts are cached independently", () => {
		const report = validateCiFabricContract(
			createHoboCiFabricContract({
				workflow: {
					artifactCache: {
						entries: [{ kind: "wasm", path: "~/.cache/hobo/wasm" }],
					},
				},
			}),
			SAMPLE_WORKFLOWS,
		);

		expect(report.passed).toBe(false);
		expect(report.violations).toContainEqual({
			code: "cache.oci.missing",
			message: "CI cache must include OCI build artifacts",
		});
	});
});
