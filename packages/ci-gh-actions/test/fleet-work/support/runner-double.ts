/**
 * A sandbox driver for the runner's logic tests: `createFakeSandboxDriver`
 * from `@hobo/fleet/testing` (it isolates nothing and answers the fence
 * through its callback), with GitHub's runner played by the test.
 *
 * When the runner's start command runs (the exec whose environment names
 * `ACTIONS_RUNNER_HOOK_JOB_STARTED`), the double stands for GitHub assigning
 * the runner a job: if the hook was installed and a registration written, it
 * posts the job context the test chose to `<controlUrl>/fence` the way the
 * fake driver answers it, runs the job's "steps" only when the fence allows,
 * and prints what run.sh and the start script print. With no job, it prints
 * nothing, as a runner GitHub never assigns.
 */
import type {
	ObservedAssignment,
	Sandbox,
	SandboxDriver,
	SandboxTier,
} from "@hobo/fleet";
import { createFakeSandboxDriver } from "@hobo/fleet/testing";
import {
	HOOK_PATH,
	MARKER,
	REGISTRATION_PATH,
} from "../../../src/fleet-work/hook.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type RecordedExec = Readonly<{
	argv: readonly string[];
	env: Readonly<Record<string, string>>;
	stdin: string;
}>;

export type GithubRunnerDouble = SandboxDriver &
	Readonly<{
		execs: RecordedExec[];
		secrets: Map<string, string>;
		/** Job names whose steps ran (the fence allowed them). */
		stepsRan: string[];
		/** Hook verdicts, in order. */
		fenced: boolean[];
		images: string[];
	}>;

export function githubRunnerDouble(
	tier: SandboxTier,
	job: () =>
		| Readonly<{ name: string; observed: ObservedAssignment; result?: string }>
		| undefined,
): GithubRunnerDouble {
	const inner = createFakeSandboxDriver(tier);
	const execs: RecordedExec[] = [];
	const secrets = new Map<string, string>();
	const stepsRan: string[] = [];
	const fenced: boolean[] = [];
	const images: string[] = [];
	return {
		tier,
		execs,
		secrets,
		stepsRan,
		fenced,
		images,
		available: () => inner.available(),
		async create(input): Promise<Sandbox> {
			images.push(input.image);
			const sandbox = await inner.create(input);
			let hook = "";
			return {
				id: sandbox.id,
				tier: sandbox.tier,
				controlUrl: sandbox.controlUrl,
				async writeSecret(path, bytes) {
					secrets.set(path, decoder.decode(bytes));
					await sandbox.writeSecret(path, bytes);
				},
				destroy: () => sandbox.destroy(),
				async exec(command) {
					const stdin = decoder.decode(command.stdin ?? new Uint8Array());
					execs.push({
						argv: [...command.argv],
						env: { ...command.env },
						stdin,
					});
					if (command.argv.includes(HOOK_PATH) && command.argv[0] === "sh")
						hook = stdin;
					if (command.env.ACTIONS_RUNNER_HOOK_JOB_STARTED === undefined)
						return sandbox.exec(command);
					const assigned = job();
					const print = (text: string) =>
						command.onOutput(encoder.encode(text));
					if (
						assigned === undefined ||
						command.env.ACTIONS_RUNNER_HOOK_JOB_STARTED !== HOOK_PATH ||
						!hook.includes(`${sandbox.controlUrl}/fence`) ||
						!secrets.has(REGISTRATION_PATH)
					) {
						print(
							`${MARKER} fence none\n${MARKER} observed \n${MARKER} exit 1\n`,
						);
						return { exitCode: 0 };
					}
					print(`√ Connected to GitHub\nRunning job: ${assigned.name}\n`);
					let answer = "";
					const posted = await sandbox.exec({
						argv: ["sh", HOOK_PATH, `${sandbox.controlUrl}/fence`],
						env: {},
						stdin: encoder.encode(JSON.stringify(assigned.observed)),
						signal: command.signal,
						onOutput(chunk) {
							answer += decoder.decode(chunk);
						},
					});
					const allowed =
						posted.exitCode === 0 && answer.includes('"allow":true');
					fenced.push(allowed);
					if (allowed) stepsRan.push(assigned.name);
					const result = allowed ? (assigned.result ?? "Succeeded") : "Failed";
					print(
						[
							`Job ${assigned.name} completed with result: ${result}`,
							`${MARKER} fence ${allowed ? "allow" : "refuse"}`,
							`${MARKER} observed ${JSON.stringify(assigned.observed)}`,
							`${MARKER} exit 0`,
							"",
						].join("\n"),
					);
					return { exitCode: 0 };
				},
			};
		},
	};
}
