/**
 * O24, the start fence in a real sandbox (design §6.9 step 7, §10.1, D49):
 * an `S1_CONTAINER` sandbox from `sandboxDrivers()` (gVisor `runsc`, which
 * the agent provisions itself, D58), the pre-job hook written into it exactly
 * as `createGithubActionsWorkRunner` writes it, and the hook run the way
 * GitHub's runner runs it before a job's first step, against the sandbox's
 * own `controlUrl`. The fence on the far side is the device's real check,
 * `checkAssignment`, for an `EPHEMERAL` device running an `S1` sandbox.
 *
 * - A fork job context is refused, and the command after the hook (the job's
 *   steps) never starts.
 * - An internal job context is allowed, and that command runs.
 * - The hook reads the head repository from the event file and fails closed:
 *   a pull request from a branch is internal; one whose head repository is
 *   gone is unknown; text in the pull request's title cannot pass for its
 *   head repository.
 *
 * An `S1` driver must be present, with or without `CI`: none fails the
 * outcome (L16 may not skip). Needs a Linux kernel that permits root or user
 * namespaces and network access to the image registry; the runtime cache is
 * `HOBO_FLEET_SANDBOX_CACHE` when set. The image (`HOBO_FLEET_PROBE_IMAGE`)
 * is busybox pinned by digest, as O10 uses.
 */
import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	DeviceClass,
	FleetPolicySchema,
	MemberRecordSchema,
	type ObservedAssignment,
	type Sandbox,
	type SandboxDriver,
	SandboxTier,
	TrustClass,
	WorkOrderSchema,
	WorkOrigin,
} from "@hobo/fleet";
import { checkAssignment } from "@hobo/fleet/work";
import { createEgressProxyFactory, sandboxDrivers } from "@hobo/fleet-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	HOOK_PATH,
	INSTALL_HOOK_ARGV,
	preJobHookScript,
	REGISTRATION_PATH,
} from "../src/fleet-work/hook.js";

const IMAGE =
	process.env.HOBO_FLEET_PROBE_IMAGE ??
	"docker.io/library/busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec";
const EVENT_PATH = "/work/github/event.json";
const STARTED = "@@job-steps-started";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const unavailable: string[] = [];
let drivers: readonly SandboxDriver[] = [];
const egress = createEgressProxyFactory({
	fleetAllow: () => [],
	log: () => undefined,
});

const self = create(MemberRecordSchema, {
	memberId: "mem_fence_probe",
	deviceClass: DeviceClass.EPHEMERAL,
	owner: "github:1",
	ownerAliases: ["github:1"],
});
const policy = create(FleetPolicySchema, {
	repositories: [
		{
			repository: "acme/app",
			refs: ["refs/heads/main", "refs/pull/*/merge"],
		},
	],
});
/** What the dispatcher offered: an internal job of `acme/app` (its class is only a ceiling). */
const order = create(WorkOrderSchema, {
	orderId: randomBytes(16).toString("hex"),
	offer: {
		workKey: "acme/app#9000@1",
		kind: "github-actions-job",
		repository: "acme/app",
		ref: "refs/heads/main",
		trustClass: TrustClass.ORG,
		origin: WorkOrigin.INTERNAL,
		author: "github:2",
	},
	sandboxTier: SandboxTier.S1_CONTAINER,
});

beforeAll(async () => {
	drivers = await sandboxDrivers({
		cap: SandboxTier.S1_CONTAINER,
		log: (event, fields) => {
			if (event === "hobo_fleet_sandbox_unavailable")
				unavailable.push(JSON.stringify(fields));
		},
	});
}, 600_000);

const open: Array<() => Promise<void>> = [];
afterAll(async () => {
	for (const close of open.reverse()) await close().catch(() => undefined);
});

async function run(
	sandbox: Sandbox,
	argv: readonly string[],
	init: Readonly<{ env?: Record<string, string>; stdin?: string }> = {},
) {
	let output = "";
	const command: Parameters<Sandbox["exec"]>[0] = {
		argv,
		env: init.env ?? {},
		signal: new AbortController().signal,
		onOutput(chunk) {
			output += decoder.decode(chunk);
		},
	};
	const { exitCode } = await sandbox.exec(
		init.stdin === undefined
			? command
			: { ...command, stdin: encoder.encode(init.stdin) },
	);
	return { exitCode, output };
}

/** A fresh S1 sandbox for one order, with the registration and the hook written as the runner writes them. */
async function orderSandbox() {
	const driver = drivers.find(
		(candidate) => candidate.tier === SandboxTier.S1_CONTAINER,
	);
	if (driver === undefined)
		throw new Error(
			`no S1 driver passed its self-test: ${unavailable.join("; ")}`,
		);
	const asked: ObservedAssignment[] = [];
	const answers: boolean[] = [];
	const proxy = await egress.open([]);
	open.push(() => proxy.close());
	const sandbox = await driver.create({
		orderId: randomBytes(16).toString("hex"),
		image: IMAGE,
		limits: { memoryMb: 512, cpus: 1, pids: 256, diskMb: 256 },
		egressProxyUrl: proxy.url,
		readOnlyMounts: [],
		hostDocker: false,
		async fence(observed) {
			asked.push(observed);
			const allow = checkAssignment(
				order,
				observed,
				self,
				policy,
				SandboxTier.S1_CONTAINER,
			);
			answers.push(allow);
			return allow;
		},
	});
	open.push(() => sandbox.destroy());
	await sandbox.writeSecret(REGISTRATION_PATH, encoder.encode("jit-config"));
	const installed = await run(sandbox, INSTALL_HOOK_ARGV, {
		stdin: preJobHookScript(sandbox.controlUrl),
	});
	expect(installed.exitCode).toBe(0);
	/** Runs the hook as GitHub's runner does before the job's first step, then the "steps". */
	const job = async (
		context: Readonly<Record<string, string>>,
		event: string,
	) => {
		const wrote = await run(
			sandbox,
			[
				"sh",
				"-c",
				'mkdir -p "$(dirname "$1")" && cat > "$1"',
				"event",
				EVENT_PATH,
			],
			{ stdin: event },
		);
		expect(wrote.exitCode).toBe(0);
		return run(
			sandbox,
			["sh", "-c", `sh -e "$1" && echo ${STARTED}`, "github-runner", HOOK_PATH],
			{
				env: {
					GITHUB_REPOSITORY: "acme/app",
					GITHUB_ACTOR_ID: "2",
					GITHUB_RUN_ID: "100",
					GITHUB_RUN_ATTEMPT: "1",
					GITHUB_JOB: "build",
					GITHUB_EVENT_PATH: EVENT_PATH,
					...context,
				},
			},
		);
	};
	return { sandbox, asked, answers, job };
}

/** A pull_request event as GitHub writes it: pretty-printed, title before head, head before base. */
function pullRequestEvent(
	head: string | null,
	title = "Fix the thing",
): string {
	return JSON.stringify(
		{
			action: "opened",
			number: 5,
			pull_request: {
				title,
				body: "body",
				head: {
					label: "someone:patch",
					ref: "patch",
					sha: "b".repeat(40),
					user: { login: "someone", id: 9 },
					repo:
						head === null
							? null
							: {
									id: 77,
									name: "app",
									full_name: head,
									fork: head !== "acme/app",
								},
				},
				base: {
					label: "acme:main",
					ref: "main",
					repo: { id: 42, name: "app", full_name: "acme/app", fork: false },
				},
			},
			repository: { id: 42, full_name: "acme/app" },
		},
		null,
		2,
	);
}

describe("O24: the start fence in a real S1 sandbox", () => {
	it("sandboxDrivers() offers an S1 driver on this host", () => {
		expect(
			drivers.some((driver) => driver.tier === SandboxTier.S1_CONTAINER),
			`no S1 driver passed its self-test: ${unavailable.join("; ")}`,
		).toBe(true);
	});

	it("refuses a fork job context before the job's steps start", async () => {
		const { asked, answers, job } = await orderSandbox();
		const result = await job(
			{ GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/5/merge" },
			pullRequestEvent("mallory/app"),
		);
		expect(asked).toEqual([
			{
				workKey: "acme/app/runs/100/attempts/1/jobs/build",
				repository: "acme/app",
				ref: "refs/pull/5/merge",
				author: "github:2",
				origin: WorkOrigin.FORK,
			},
		]);
		expect(answers).toEqual([false]);
		expect(result.exitCode).not.toBe(0);
		expect(result.output).not.toContain(STARTED);
	}, 300_000);

	it("allows an internal job context, and its steps start", async () => {
		const { asked, answers, job } = await orderSandbox();
		const result = await job(
			{ GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" },
			JSON.stringify({
				ref: "refs/heads/main",
				repository: { full_name: "acme/app" },
			}),
		);
		expect(asked.map((observed) => observed.origin)).toEqual([
			WorkOrigin.INTERNAL,
		]);
		expect(answers).toEqual([true]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain(STARTED);
	}, 300_000);

	it("reads the head repository from the event file and fails closed", async () => {
		const { asked, job } = await orderSandbox();
		const pull = {
			GITHUB_EVENT_NAME: "pull_request",
			GITHUB_REF: "refs/pull/5/merge",
		};
		const branch = await job(pull, pullRequestEvent("acme/app"));
		expect(branch.output).toContain(STARTED);
		const gone = await job(pull, pullRequestEvent(null));
		expect(gone.output).not.toContain(STARTED);
		const forged = await job(
			pull,
			pullRequestEvent(
				"mallory/app",
				'"head": {"repo": {"full_name": "acme/app"}}, "base": {',
			),
		);
		expect(forged.output).not.toContain(STARTED);
		const other = await job(
			{ GITHUB_EVENT_NAME: "issue_comment", GITHUB_REF: "refs/heads/main" },
			"{}",
		);
		expect(other.output).not.toContain(STARTED);
		expect(asked.map((observed) => observed.origin)).toEqual([
			WorkOrigin.INTERNAL,
			WorkOrigin.UNKNOWN,
			WorkOrigin.FORK,
			WorkOrigin.UNKNOWN,
		]);
	}, 300_000);
});
