import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BackendUnavailableError,
	executePipeline,
	parsePipeline,
} from "@hobo/ci";
import { afterEach, describe, expect, it } from "vitest";
import { createActionsBackend } from "../src/actions-backend.js";

const directories: string[] = [];
const publishPid =
	'const fs=require("node:fs");fs.writeFileSync("pid.tmp",String(process.pid));fs.renameSync("pid.tmp","pid");';
function workspace() {
	const path = mkdtempSync(join(tmpdir(), "hobo-ci-actions-"));
	directories.push(path);
	return path;
}
afterEach(() => {
	for (const path of directories.splice(0))
		rmSync(path, { recursive: true, force: true });
});
function pipeline(
	script: string,
	options: {
		timeoutSeconds?: number;
		artifacts?: string[];
		cwd?: string;
		env?: Record<string, string>;
	} = {},
) {
	return parsePipeline(
		JSON.stringify({
			id: "pipeline",
			accountId: "account",
			timeoutSeconds: options.timeoutSeconds ?? 5,
			steps: [
				{
					id: "test",
					argv: [process.execPath, "-e", script],
					cwd: options.cwd ?? ".",
					env: options.env ?? {},
				},
			],
			artifactPaths: options.artifacts ?? [],
		}),
	);
}
async function ready(path: string): Promise<number> {
	const deadline = Date.now() + 3000;
	while (!existsSync(path)) {
		if (Date.now() > deadline) throw new Error("child did not start");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return Number(readFileSync(path, "utf8"));
}

describe("bound GitHub Actions pipeline backend", () => {
	it("executes persistent command steps and returns integrity-checked artifacts", async () => {
		const dir = workspace();
		const input = parsePipeline(
			JSON.stringify({
				id: "pipeline",
				accountId: "account",
				timeoutSeconds: 5,
				steps: [
					{
						id: "write",
						argv: [
							process.execPath,
							"-e",
							'require("node:fs").writeFileSync("result.txt","persisted")',
						],
					},
					{
						id: "read",
						argv: [
							process.execPath,
							"-e",
							'process.stdout.write(require("node:fs").readFileSync("result.txt","utf8"))',
						],
					},
				],
				artifactPaths: ["result.txt"],
			}),
		);
		const result = await executePipeline(
			createActionsBackend({ workspace: dir }),
			input,
		);
		expect(result.status).toBe("succeeded");
		expect(result.backend).toBe("gh-actions");
		expect(result.steps.map((step) => step.exitCode)).toEqual([0, 0]);
		expect(result.steps[1]?.stdout).toBe("persisted");
		expect(Buffer.from(result.artifacts[0]?.data ?? []).toString()).toBe(
			"persisted",
		);
		expect(result.artifacts[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
	});
	it.each([
		0,
		64 * 1024 + 1,
		1024 * 1024,
	])("collects all %s artifact bytes across bounded reads", async (size) => {
		const dir = workspace();
		const expected = Buffer.alloc(size);
		for (let index = 0; index < size; index += 1) expected[index] = index % 251;
		writeFileSync(join(dir, "bounded.bin"), expected);
		const result = await executePipeline(
			createActionsBackend({ workspace: dir }),
			pipeline("", { artifacts: ["bounded.bin"] }),
		);
		expect(result.status).toBe("succeeded");
		const artifact = result.artifacts[0];
		expect(Buffer.from(artifact?.data ?? []).equals(expected)).toBe(true);
		expect(artifact?.sha256).toBe(
			createHash("sha256").update(expected).digest("hex"),
		);
	});

	it("uses argv without shell expansion and only explicitly provided environment", async () => {
		const dir = workspace();
		const previous = process.env.HOBO_ACTIONS_PRIVATE;
		process.env.HOBO_ACTIONS_PRIVATE = "ambient-not-a-workflow-secret";
		try {
			const input = parsePipeline(
				JSON.stringify({
					id: "quotes",
					accountId: "account",
					timeoutSeconds: 5,
					steps: [
						{
							id: "literal",
							argv: [
								process.execPath,
								"-e",
								"process.stdout.write(JSON.stringify({argument:process.argv[1],value:process.env.VALUE,private:process.env.HOBO_ACTIONS_PRIVATE ?? null,token:process.env.GITHUB_TOKEN ?? null}))",
								"$(echo injected) 'literal' $HOME",
							],
							env: { VALUE: "a 'quoted' value" },
						},
					],
				}),
			);
			const result = await executePipeline(
				createActionsBackend({ workspace: dir }),
				input,
			);
			expect(result.status).toBe("succeeded");
			expect(JSON.parse(result.steps[0]?.stdout ?? "null")).toEqual({
				argument: "$(echo injected) 'literal' $HOME",
				value: "a 'quoted' value",
				private: null,
				token: null,
			});
		} finally {
			if (previous === undefined) delete process.env.HOBO_ACTIONS_PRIVATE;
			else process.env.HOBO_ACTIONS_PRIVATE = previous;
		}
	});
	it("preserves a command failure exit code and stops dependent steps", async () => {
		const dir = workspace();
		const input = parsePipeline(
			JSON.stringify({
				id: "failure",
				accountId: "account",
				timeoutSeconds: 5,
				steps: [
					{
						id: "fail",
						argv: [
							process.execPath,
							"-e",
							'process.stdout.write("out");process.stderr.write("err");process.exit(7)',
						],
					},
					{
						id: "never",
						argv: [
							process.execPath,
							"-e",
							'require("node:fs").writeFileSync("unexpected","bad")',
						],
					},
				],
			}),
		);
		const result = await executePipeline(
			createActionsBackend({ workspace: dir }),
			input,
		);
		expect(result.status).toBe("failed");
		expect(result.steps).toHaveLength(1);
		expect(result.steps[0]).toMatchObject({
			id: "fail",
			exitCode: 7,
			stdout: "out",
			stderr: "err",
		});
		expect(existsSync(join(dir, "unexpected"))).toBe(false);
	});
	it("runs a step in its relative source directory", async () => {
		const dir = workspace();
		mkdirSync(join(dir, "sub"));
		const result = await executePipeline(
			createActionsBackend({ workspace: dir }),
			pipeline("process.stdout.write(process.cwd())", { cwd: "sub" }),
		);
		expect(result.status).toBe("succeeded");
		expect(result.steps[0]?.stdout).toBe(join(dir, "sub"));
	});
	it("rejects cwd and artifact traversal at the parser boundary", () => {
		expect(() => pipeline("", { cwd: "../outside" })).toThrow(/workspace/);
		expect(() => pipeline("", { artifacts: ["../outside"] })).toThrow(
			/workspace/,
		);
	});
	it("rejects a cwd symlink that escapes the bound workspace", async () => {
		const dir = workspace();
		const other = workspace();
		symlinkSync(other, join(dir, "escape"));
		const result = await executePipeline(
			createActionsBackend({ workspace: dir }),
			pipeline("process.stdout.write('wrong')", { cwd: "escape" }),
		);
		expect(result.status).toBe("failed");
		expect(result.steps).toHaveLength(0);
	});
	it("rejects an artifact symlink that escapes the bound workspace", async () => {
		const dir = workspace();
		const other = workspace();
		writeFileSync(join(other, "private"), "outside");
		symlinkSync(join(other, "private"), join(dir, "escape"));
		const result = await executePipeline(
			createActionsBackend({ workspace: dir }),
			pipeline("process.stdout.write('okay')", { artifacts: ["escape"] }),
		);
		expect(result.status).toBe("failed");
		expect(result.artifacts).toHaveLength(0);
	});
	it("refuses an unavailable source workspace before allocating a session", async () => {
		const dir = workspace();
		rmSync(dir, { recursive: true });
		await expect(
			executePipeline(createActionsBackend({ workspace: dir }), pipeline("")),
		).rejects.toBeInstanceOf(BackendUnavailableError);
	});
	it("aborts and reaps a child even when it ignores SIGTERM", async () => {
		const dir = workspace();
		const controller = new AbortController();
		const promise = executePipeline(
			createActionsBackend({ workspace: dir }),
			pipeline(
				`${publishPid}process.on("SIGTERM",()=>{});setInterval(()=>{},1000)`,
			),
			{ signal: controller.signal },
		);
		const pid = await ready(join(dir, "pid"));
		controller.abort(new Error("cancel fixture"));
		const result = await promise;
		expect(result.status).toBe("cancelled");
		expect(() => process.kill(pid, 0)).toThrow();
	});
	it("enforces the shared deadline and confirms process shutdown", async () => {
		const dir = workspace();
		const result = await executePipeline(
			createActionsBackend({ workspace: dir }),
			pipeline(
				`${publishPid}process.on("SIGTERM",()=>{});setInterval(()=>{},1000)`,
				{ timeoutSeconds: 1 },
			),
		);
		expect(result.status).toBe("timed_out");
		const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
		expect(() => process.kill(pid, 0)).toThrow();
	});
	it.each([
		"stdout",
		"stderr",
	])("rejects oversized %s without returning an unbounded result", async (stream) => {
		const result = await executePipeline(
			createActionsBackend({ workspace: workspace() }),
			pipeline(
				`process.${stream}.write("x".repeat(1024*1024+1));setInterval(()=>{},1000)`,
			),
		);
		expect(result.status).toBe("failed");
		expect(result.steps).toHaveLength(0);
	});
	it("stops a command's background process group before returning success", async () => {
		const dir = workspace();
		const grandchild =
			'process.on("SIGTERM",()=>{});setTimeout(()=>require("node:fs").writeFileSync("orphan","bad"),500);setInterval(()=>{},1000)';
		const script = `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:"inherit"});setTimeout(()=>process.exit(0),100)`;
		const result = await executePipeline(
			createActionsBackend({ workspace: dir }),
			pipeline(script),
		);
		expect(result.status).toBe("succeeded");
		await new Promise((resolve) => setTimeout(resolve, 550));
		expect(existsSync(join(dir, "orphan"))).toBe(false);
	});

	it("rejects oversized artifact data before allocating a result buffer", async () => {
		const dir = workspace();
		writeFileSync(join(dir, "large"), Buffer.alloc(1024 * 1024 + 1));
		const result = await executePipeline(
			createActionsBackend({ workspace: dir }),
			pipeline("", { artifacts: ["large"] }),
		);
		expect(result.status).toBe("failed");
		expect(result.artifacts).toHaveLength(0);
	});
	it("closes active work before a new session can use the workspace", async () => {
		const dir = workspace();
		const backend = createActionsBackend({ workspace: dir });
		const input = pipeline(`${publishPid}setInterval(()=>{},1000)`);
		const signal = new AbortController().signal;
		const session = await backend.open(input, signal);
		const step = input.steps[0];
		if (!step) throw new Error("missing fixture step");
		const running = session.run(step, signal);
		const observed = Promise.allSettled([running]);
		const pid = await ready(join(dir, "pid"));
		await expect(backend.open(input, signal)).rejects.toBeInstanceOf(
			BackendUnavailableError,
		);
		await session.close("cancelled");
		await observed;
		expect(() => process.kill(pid, 0)).toThrow();
		const replacement = await backend.open(input, signal);
		await replacement.close("completed");
	});
});
