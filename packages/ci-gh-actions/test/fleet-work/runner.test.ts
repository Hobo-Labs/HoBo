/**
 * The executor half of `github-actions-job` (design §6.9 step 7): the
 * registration goes in with `Sandbox.writeSecret` and nowhere else, the
 * pre-job hook is installed pointing at the sandbox's own control endpoint,
 * one runner runs, and the receipt status follows the runner's result line
 * and the hook's verdict.
 */
import { create } from "@bufbuild/protobuf";
import {
	type ObservedAssignment,
	ReceiptStatus,
	type Sandbox,
	SandboxTier,
	WorkOrderSchema,
	WorkOrigin,
} from "@hobo/fleet";
import { describe, expect, it } from "vitest";
import {
	HOOK_PATH,
	preJobHookScript,
	REGISTRATION_PATH,
	START_SCRIPT,
} from "../../src/fleet-work/hook.js";
import { createGithubActionsWorkRunner } from "../../src/fleet-work/index.js";
import { readVerdict } from "../../src/fleet-work/runner.js";
import { githubRunnerDouble } from "./support/runner-double.js";

const SECRET = "jit-config-secret-value";

const internal: ObservedAssignment = {
	workKey: "acme/app/runs/1/attempts/1/jobs/build",
	repository: "acme/app",
	ref: "refs/heads/main",
	author: "github:2",
	origin: WorkOrigin.INTERNAL,
};

function order() {
	return create(WorkOrderSchema, {
		orderId: "0123456789abcdef0123456789abcdef",
		parameters: { image: "ghcr.io/actions/actions-runner:2.338.2" },
		offer: { workKey: "acme/app#9000@1", kind: "github-actions-job" },
	});
}

async function runWith(
	fence: (observed: ObservedAssignment) => Promise<boolean>,
	job: Parameters<typeof githubRunnerDouble>[1],
	init: Readonly<{ secret?: string; abort?: boolean }> = {},
) {
	const driver = githubRunnerDouble(SandboxTier.S1_CONTAINER, job);
	const sandbox: Sandbox = await driver.create({
		orderId: "0123456789abcdef0123456789abcdef",
		image: "runner",
		limits: { memoryMb: 1024, cpus: 1, pids: 64, diskMb: 1024 },
		egressProxyUrl: "http://proxy.invalid:3128",
		readOnlyMounts: [],
		hostDocker: false,
		fence,
	});
	const logs: string[] = [];
	const abort = new AbortController();
	if (init.abort === true) abort.abort();
	const outcome = await createGithubActionsWorkRunner().run({
		order: order(),
		secret: new TextEncoder().encode(init.secret ?? SECRET),
		sandbox,
		signal: abort.signal,
		onLog: (chunk) => logs.push(new TextDecoder().decode(chunk)),
		log: () => undefined,
	});
	return { outcome, driver, logs, sandbox };
}

describe("createGithubActionsWorkRunner", () => {
	it("has the kind github-actions-job", () => {
		expect(createGithubActionsWorkRunner().kind).toBe("github-actions-job");
	});

	it("writes the registration only with writeSecret and installs the hook for this sandbox's control endpoint", async () => {
		const { outcome, driver, sandbox } = await runWith(
			async () => true,
			() => ({ name: "build", observed: internal }),
		);
		expect(outcome.status).toBe(ReceiptStatus.SUCCEEDED);
		expect(driver.secrets.get(REGISTRATION_PATH)).toBe(SECRET);
		for (const exec of driver.execs) {
			expect(exec.argv.join(" ")).not.toContain(SECRET);
			expect(JSON.stringify(exec.env)).not.toContain(SECRET);
			expect(exec.stdin).not.toContain(SECRET);
		}
		const install = driver.execs[0];
		expect(install?.argv).toContain(HOOK_PATH);
		expect(install?.stdin).toBe(preJobHookScript(sandbox.controlUrl));
		expect(install?.stdin).toContain(`'${sandbox.controlUrl}/fence'`);
		const start = driver.execs[1];
		expect(start?.argv).toContain(START_SCRIPT);
		expect(start?.env.ACTIONS_RUNNER_HOOK_JOB_STARTED).toBe(HOOK_PATH);
	});

	it("succeeds when the fence allows the job and its result is Succeeded, recording the job actually run", async () => {
		const asked: ObservedAssignment[] = [];
		const { outcome, driver, logs } = await runWith(
			async (observed) => {
				asked.push(observed);
				return true;
			},
			() => ({ name: "build", observed: internal }),
		);
		expect(asked).toEqual([internal]);
		expect(driver.stepsRan).toEqual(["build"]);
		expect(outcome).toMatchObject({
			status: ReceiptStatus.SUCCEEDED,
			reason: "",
			observedWorkKey: internal.workKey,
		});
		expect(outcome.outputDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
		expect(logs.join("")).toContain("Running job: build");
	});

	it("stops a fork job at the fence before a step runs and refuses it", async () => {
		const fork = { ...internal, origin: WorkOrigin.FORK };
		const { outcome, driver } = await runWith(
			async (observed) => observed.origin === WorkOrigin.INTERNAL,
			() => ({ name: "build", observed: fork }),
		);
		expect(driver.fenced).toEqual([false]);
		expect(driver.stepsRan).toEqual([]);
		expect(outcome.status).toBe(ReceiptStatus.REFUSED);
		expect(outcome.reason).toBe("assignment-mismatch");
	});

	it("reports a failed job FAILED and a runner GitHub never assigned ABANDONED", async () => {
		const failed = await runWith(
			async () => true,
			() => ({ name: "test", observed: internal, result: "Failed" }),
		);
		expect(failed.outcome.status).toBe(ReceiptStatus.FAILED);
		const idle = await runWith(
			async () => true,
			() => undefined,
		);
		expect(idle.outcome.status).toBe(ReceiptStatus.ABANDONED);
		expect(idle.outcome.reason).toBe("unavailable");
		expect(idle.outcome.observedWorkKey).toBe("");
	});

	it("refuses an order without a registration and cancels an aborted one", async () => {
		const empty = await runWith(
			async () => true,
			() => undefined,
			{
				secret: "",
			},
		);
		expect(empty.outcome.status).toBe(ReceiptStatus.REFUSED);
		expect(empty.driver.execs).toEqual([]);
		const aborted = await runWith(
			async () => true,
			() => undefined,
			{
				abort: true,
			},
		);
		expect(aborted.outcome.status).toBe(ReceiptStatus.CANCELLED);
	});
});

describe("readVerdict", () => {
	it("reads the last markers and the runner's result line", () => {
		const verdict = readVerdict(
			[
				"2026-11-13 12:00:00Z: Running job: build",
				"2026-11-13 12:01:00Z: Job build completed with result: Canceled",
				"@@hobo-fleet fence allow",
				'@@hobo-fleet observed {"workKey":"k"}',
				"@@hobo-fleet exit 0",
			].join("\n"),
		);
		expect(verdict).toEqual({
			fence: "allow",
			observedWorkKey: "k",
			result: "Canceled",
			exit: 0,
		});
		expect(readVerdict("@@hobo-fleet observed not json").observedWorkKey).toBe(
			"",
		);
	});
});
