import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { PipelineStepSchema } from "../src/_generated/ci_pb.js";
import {
	BackendUnavailableError,
	type PipelineSession,
	parsePipeline,
} from "../src/execution.js";
import {
	createWorkspaceBackend,
	workspaceEnvironment,
} from "../src/workspace-backend.js";

const cleanup: (() => void)[] = [];
const sessions: PipelineSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0))
		await session.close("completed").catch(() => {});
	for (const done of cleanup.splice(0)) done();
});

const pipeline = parsePipeline(
	JSON.stringify({
		id: "build",
		accountId: "tenant",
		timeoutSeconds: 30,
		steps: [{ id: "test", argv: ["true"] }],
	}),
);

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "hobo-ci-workspace-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function step(
	argv: string[],
	extra: { cwd?: string; env?: Record<string, string> } = {},
) {
	return create(PipelineStepSchema, {
		id: "step",
		argv,
		cwd: extra.cwd ?? "",
		env: extra.env ?? {},
	});
}

async function open(root = workspace()) {
	const backend = createWorkspaceBackend({
		workspace: root,
		kind: "gh-actions",
	});
	const session = await backend.open(pipeline, new AbortController().signal);
	sessions.push(session);
	return { root, backend, session };
}

const signal = () => new AbortController().signal;

describe("workspace backend", () => {
	it("advertises its kind and capabilities", () => {
		const backend = createWorkspaceBackend({ workspace: ".", kind: "ado" });
		expect(backend.kind).toBe("ado");
		expect(backend.capabilities).toEqual([
			"commands",
			"artifacts",
			"cancellation",
		]);
	});

	it("runs a command in the bound workspace with only explicit inputs", async () => {
		const { root, session } = await open();
		mkdirSync(join(root, "sub"));
		const result = await session.run(
			step(
				[
					"sh",
					"-c",
					'pwd; printf "%s|%s|%s" "$HOBO_CI_EXECUTION_ID" "$GIVEN" "${SECRET_TOKEN:-unset}"; echo err >&2; exit 3',
				],
				{ cwd: "sub", env: { GIVEN: "yes" } },
			),
			signal(),
		);
		expect(result.exitCode).toBe(3);
		expect(result.stdout).toContain("/sub");
		expect(result.stdout).toContain("build|yes|unset");
		expect(result.stderr).toBe("err\n");
	});

	it("refuses a second lease until the first session closes", async () => {
		const root = workspace();
		const backend = createWorkspaceBackend({
			workspace: root,
			kind: "gh-actions",
		});
		const first = await backend.open(pipeline, signal());
		await expect(backend.open(pipeline, signal())).rejects.toThrow(
			"source workspace already has an active pipeline session",
		);
		await first.close("completed");
		await first.close("completed");
		const second = await backend.open(pipeline, signal());
		await second.close("completed");
	});

	it("reports a missing or non-directory workspace as unavailable", async () => {
		const root = workspace();
		writeFileSync(join(root, "file"), "x");
		for (const bound of [join(root, "missing"), join(root, "file")]) {
			const backend = createWorkspaceBackend({
				workspace: bound,
				kind: "gh-actions",
			});
			await expect(backend.open(pipeline, signal())).rejects.toBeInstanceOf(
				BackendUnavailableError,
			);
		}
	});

	it("rethrows the abort when opening is cancelled", async () => {
		const backend = createWorkspaceBackend({
			workspace: workspace(),
			kind: "gh-actions",
		});
		const controller = new AbortController();
		controller.abort(new Error("stopped"));
		await expect(backend.open(pipeline, controller.signal)).rejects.toThrow(
			"stopped",
		);
	});

	it("keeps commands and artifacts inside the workspace", async () => {
		const outside = workspace();
		const { root, session } = await open();
		symlinkSync(outside, join(root, "escape"));
		await expect(
			session.run(step(["true"], { cwd: "escape" }), signal()),
		).rejects.toThrow("path escapes bound source workspace");
		writeFileSync(join(outside, "secret"), "s");
		await expect(session.artifact("escape/secret", signal())).rejects.toThrow(
			"path escapes bound source workspace",
		);
	});

	it("refuses an empty command and a program that cannot start", async () => {
		const { session } = await open();
		await expect(session.run(step([]), signal())).rejects.toThrow(
			"empty command",
		);
		await expect(
			session.run(step(["/nonexistent/hobo-program"]), signal()),
		).rejects.toThrow("command could not start");
	});

	it("stops a command whose output exceeds one MiB", async () => {
		const { session } = await open();
		await expect(
			session.run(
				step(["sh", "-c", "head -c 2000000 /dev/zero; sleep 5"]),
				signal(),
			),
		).rejects.toThrow("command output exceeds one MiB limit");
	});

	it("cancels a running command and an already aborted one", async () => {
		const { session } = await open();
		const controller = new AbortController();
		const running = session.run(step(["sleep", "5"]), controller.signal);
		setTimeout(() => controller.abort(), 50);
		await expect(running).rejects.toThrow("command cancelled");
		const aborted = new AbortController();
		aborted.abort(new Error("before start"));
		await expect(session.run(step(["true"]), aborted.signal)).rejects.toThrow(
			"before start",
		);
	});

	it("is busy during a command and stops it when the session closes", async () => {
		const { session } = await open();
		const running = session.run(step(["sleep", "5"]), signal());
		await new Promise((resolve) => setTimeout(resolve, 50));
		await expect(session.run(step(["true"]), signal())).rejects.toThrow(
			"CI session is closed or busy",
		);
		const closed = session.close("cancelled");
		await expect(running).rejects.toThrow("CI session closed during command");
		await closed;
		await expect(session.run(step(["true"]), signal())).rejects.toThrow(
			"CI session is closed or busy",
		);
	});

	it("collects a bounded regular file as an artifact", async () => {
		const { root, session } = await open();
		writeFileSync(join(root, "out.txt"), "artifact body");
		const artifact = await session.artifact("out.txt", signal());
		expect(artifact.path).toBe("out.txt");
		expect(new TextDecoder().decode(artifact.data)).toBe("artifact body");
		writeFileSync(join(root, "empty"), "");
		expect((await session.artifact("empty", signal())).data.byteLength).toBe(0);
		mkdirSync(join(root, "dir"));
		await expect(session.artifact("dir", signal())).rejects.toThrow(
			"artifact is not a bounded regular file",
		);
		writeFileSync(join(root, "big"), Buffer.alloc(1024 * 1024 + 1));
		await expect(session.artifact("big", signal())).rejects.toThrow(
			"artifact is not a bounded regular file",
		);
		writeFileSync(join(root, "target"), "t");
		symlinkSync(join(root, "target"), join(root, "link"));
		const linked = await session.artifact("link", signal());
		expect(linked.path).toBe("link");
		expect(new TextDecoder().decode(linked.data)).toBe("t");
		const aborted = new AbortController();
		aborted.abort(new Error("no artifact"));
		await expect(session.artifact("out.txt", aborted.signal)).rejects.toThrow(
			"no artifact",
		);
	});
});

describe("workspace environment", () => {
	it("inherits only host plumbing, never credentials", () => {
		expect(
			workspaceEnvironment({
				PATH: "/bin",
				HOME: "/home/ci",
				HTTPS_PROXY: "http://proxy",
				GITHUB_TOKEN: "secret",
				AWS_SECRET_ACCESS_KEY: "secret",
			}),
		).toEqual({ PATH: "/bin", HOME: "/home/ci", HTTPS_PROXY: "http://proxy" });
	});
});
