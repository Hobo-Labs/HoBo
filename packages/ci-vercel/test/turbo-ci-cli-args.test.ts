/**
 * `pnpm ci:local` argument handling, in process, with Turbo stood in. The
 * spawned end-to-end run is `turbo-ci-cli.test.ts`; this pins every flag and
 * every refusal without running Turbo.
 */
import { create } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type TurboCiPlan,
	TurboCiPlanSchema,
} from "../src/_generated/turbo_ci_pb.js";
import type { TurboCiOptions } from "../src/turbo-ci.js";

const plan = vi.fn(
	async (_options: TurboCiOptions): Promise<TurboCiPlan> =>
		create(TurboCiPlanSchema, {}),
);
const run = vi.fn(async (_options: TurboCiOptions): Promise<number> => 0);

const argv = process.argv;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	plan.mockClear();
	run.mockClear();
	stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
	process.argv = argv;
	process.exitCode = undefined;
	vi.restoreAllMocks();
});

/** Run the CLI with `args`, as a fresh process would, until it has written or exited. */
async function cli(...args: string[]) {
	process.argv = ["node", "turbo-ci-cli.ts", ...args];
	vi.resetModules();
	const turbo = await import("../src/turbo-ci.js");
	vi.spyOn(turbo, "planTurboCi").mockImplementation(plan);
	vi.spyOn(turbo, "runTurboCi").mockImplementation(run);
	await import("../src/turbo-ci-cli.js");
	await vi.waitFor(() => {
		if (
			process.exitCode === undefined &&
			stdout.mock.calls.length === 0 &&
			run.mock.calls.length === 0
		)
			throw new Error("still running");
	});
}

const errorText = () =>
	stderr.mock.calls.map((call) => String(call[0])).join("");

describe("pnpm ci:local", () => {
	it("prints its help and runs nothing", async () => {
		await cli("--help");
		expect(String(stdout.mock.calls[0]?.[0])).toMatch(/^Run Vercel CI-tagged/u);
		expect(plan).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});

	it("prints the plan for a dry run, passing every option through", async () => {
		plan.mockResolvedValueOnce(
			create(TurboCiPlanSchema, {
				taskIds: ["web#test"],
				runArgs: ["run", "test"],
			}),
		);
		await cli(
			"--",
			"--dry-run",
			"--affected",
			"--base",
			"main",
			"--head",
			"HEAD",
			"--cwd",
			"/repo",
			"--remote-cache",
		);
		expect(plan).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/repo",
				affected: true,
				base: "main",
				head: "HEAD",
				remoteCache: true,
			}),
		);
		expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
			taskIds: ["web#test"],
			runArgs: ["run", "test"],
		});
		expect(run).not.toHaveBeenCalled();
	});

	it("runs the tasks and exits with Turbo's code", async () => {
		run.mockResolvedValueOnce(3);
		const listeners = process.listenerCount("SIGINT");
		await cli();
		await vi.waitFor(() => expect(process.exitCode).toBe(3));
		// Its cancellation handlers are removed once the run ends.
		expect(process.listenerCount("SIGINT")).toBe(listeners);
	});

	it("cancels the run on SIGINT", async () => {
		let signal: AbortSignal | undefined;
		run.mockImplementationOnce(async (options) => {
			signal = options.signal;
			const onSigint = process.listeners("SIGINT").at(-1);
			onSigint?.("SIGINT");
			return 130;
		});
		await cli();
		await vi.waitFor(() => expect(process.exitCode).toBe(130));
		expect(signal?.aborted).toBe(true);
		expect(String(signal?.reason)).toMatch(/local CI cancelled/u);
	});

	it("refuses an unknown argument, a flag without its value, and affected mode without a base", async () => {
		const cases: [string[], RegExp][] = [
			[["--bogus"], /unknown argument: --bogus/u],
			[["--cwd"], /missing value for --cwd/u],
			[["--base", "--dry-run"], /missing value for --base/u],
			[["--affected"], /affected mode requires --base/u],
		];
		for (const [args, message] of cases) {
			stderr.mockClear();
			process.exitCode = undefined;
			await cli(...args);
			expect(process.exitCode).toBe(1);
			expect(errorText()).toMatch(message);
		}
		expect(run).not.toHaveBeenCalled();
	});
});
