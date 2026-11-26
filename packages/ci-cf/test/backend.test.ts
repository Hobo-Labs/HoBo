import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CiContext, CiRunnerResult } from "@cloudflare/ci";
import { executePipeline, parsePipeline } from "@hobo/ci/execution";
import { afterEach, describe, expect, it } from "vitest";
import { cloudflareCommand, createCloudflareBackend } from "../src/backend.js";
import { NativeContext } from "./fixtures/native-context.js";
import { verifyNativeConfig } from "./fixtures/upstream-config.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function directory() {
	const path = mkdtempSync(join(tmpdir(), "hobo-ci-cf-"));
	directories.push(path);
	return path;
}
function pipeline(
	steps = [
		{
			id: "build",
			argv: ["sh", "-c", "printf 'artifact\\n' > result.txt"],
			cwd: ".",
			env: {},
		},
	],
	artifactPaths = ["result.txt"],
	timeoutSeconds = 30,
) {
	return parsePipeline(
		JSON.stringify({
			id: "cf-contract",
			accountId: "a",
			steps,
			artifactPaths,
			timeoutSeconds,
			requiredCapabilities: [],
		}),
	);
}
function sdkResult(
	stdout: string | ReadableStream<Uint8Array>,
	next: CiContext,
): CiRunnerResult {
	return {
		exitCode: 0,
		logs: { stdout, stderr: "" },
		snapshot: { id: "snapshot", dir: "/workspace" },
		runner: next.runner,
	};
}

describe("Cloudflare native CI backend", () => {
	it("preserves chained snapshots and returns exact artifacts through the real shell wrapper", async () => {
		const native = new NativeContext(directory());
		const backend = createCloudflareBackend({
			context: native.context,
			terminate: native.terminate,
			verifyShutdown: native.verifyShutdown,
		});
		const result = await executePipeline(
			backend,
			pipeline(
				[
					{
						id: "build",
						argv: [
							"sh",
							"-c",
							"mkdir -p output; printf 'artifact\\n' > output/file",
						],
						cwd: ".",
						env: {},
					},
					{ id: "read", argv: ["cat", "output/file"], cwd: ".", env: {} },
				],
				["output/file"],
			),
		);
		expect(result.status).toBe("succeeded");
		expect(result.steps[1]?.stdout).toBe("artifact\n");
		expect(result.artifacts[0]?.data).toEqual(
			new TextEncoder().encode("artifact\n"),
		);
		expect(native.roots).toBe(1);
		expect(native.chained).toBe(2);
		expect(native.terminations).toBe(0);
		for (const request of native.requests) {
			expect(request.config?.retries).toEqual({ limit: 0, delay: 0 });
			expect(request.config?.commandTimeoutMs).toBeGreaterThan(0);
			expect(request.config?.commandTimeoutMs).toBeLessThanOrEqual(30000);
		}
	});
	it("retains edits and deletions to tracked source despite native checkout overlays", async () => {
		const workspace = directory();
		const native = new NativeContext(
			workspace,
			new Map([
				["tracked.txt", "original"],
				["delete-me.txt", "original"],
			]),
		);
		const backend = createCloudflareBackend({
			context: native.context,
			terminate: native.terminate,
			verifyShutdown: native.verifyShutdown,
		});
		const result = await executePipeline(
			backend,
			pipeline(
				[
					{
						id: "edit",
						argv: [
							"sh",
							"-c",
							"printf changed > tracked.txt; rm delete-me.txt",
						],
						cwd: ".",
						env: {},
					},
					{
						id: "verify",
						argv: ["sh", "-c", "test ! -e delete-me.txt && cat tracked.txt"],
						cwd: ".",
						env: {},
					},
				],
				["tracked.txt"],
			),
		);
		expect(result.status).toBe("succeeded");
		expect(result.steps[1]?.stdout).toBe("changed");
		expect(new TextDecoder().decode(result.artifacts[0]?.data)).toBe("changed");
		expect(readFileSync(join(workspace, "tracked.txt"), "utf8")).toBe(
			"original",
		);
		expect(readFileSync(join(workspace, "delete-me.txt"), "utf8")).toBe(
			"original",
		);
		expect(native.roots).toBe(1);
		expect(native.chained).toBe(2);
	});
	it("refuses a preexisting reserved workspace namespace", async () => {
		const workspace = directory();
		mkdirSync(join(workspace, ".hobo-ci-workspaces"));
		const native = new NativeContext(workspace);
		const result = await executePipeline(
			createCloudflareBackend({
				context: native.context,
				terminate: native.terminate,
				verifyShutdown: native.verifyShutdown,
			}),
			pipeline(
				[{ id: "edit", argv: ["touch", "executed"], cwd: ".", env: {} }],
				[],
			),
		);
		expect(result.status).toBe("failed");
		expect(result.steps[0]?.exitCode).toBe(73);
		expect(() => readFileSync(join(workspace, "executed"))).toThrow();
	});
	it("passes argv and environment literally without shell expansion", async () => {
		const native = new NativeContext(directory());
		const backend = createCloudflareBackend({
			context: native.context,
			terminate: native.terminate,
			verifyShutdown: native.verifyShutdown,
		});
		const literal = "hello $HOME; $(touch injected) 'quote'";
		const result = await executePipeline(
			backend,
			pipeline(
				[
					{
						id: "literal",
						argv: ["printf", "%s", literal],
						cwd: ".",
						env: { EXAMPLE: "literal $VALUE" },
					},
				],
				[],
			),
		);
		expect(result.steps[0]?.stdout).toBe(literal);
		expect(native.requests[0]?.env).toEqual({});
		expect(native.requests[0]?.command).toContain("EXAMPLE=literal $VALUE");
		expect(() =>
			readFileSync(
				join(
					native.workspace,
					".hobo-ci-workspaces",
					"cf-contract",
					"injected",
				),
			),
		).toThrow();
	});
	it("retains original command failure status and both output streams", async () => {
		const native = new NativeContext(directory());
		const backend = createCloudflareBackend({
			context: native.context,
			terminate: native.terminate,
			verifyShutdown: native.verifyShutdown,
		});
		const result = await executePipeline(
			backend,
			pipeline(
				[
					{
						id: "fail",
						argv: ["sh", "-c", "printf out; printf err >&2; exit 7"],
						cwd: ".",
						env: {},
					},
					{ id: "skip", argv: ["true"], cwd: ".", env: {} },
				],
				[],
			),
		);
		expect(result.status).toBe("failed");
		expect(result.steps).toHaveLength(1);
		expect(result.steps[0]).toMatchObject({
			exitCode: 7,
			stdout: "out",
			stderr: "err",
		});
		expect(native.terminations).toBe(0);
	});
	it("restores the requested working directory", async () => {
		const workspace = directory();
		mkdirSync(join(workspace, "nested"));
		writeFileSync(join(workspace, "nested", "value"), "nested");
		const native = new NativeContext(workspace);
		const result = await executePipeline(
			createCloudflareBackend({
				context: native.context,
				terminate: native.terminate,
				verifyShutdown: native.verifyShutdown,
			}),
			pipeline(
				[{ id: "cwd", argv: ["cat", "value"], cwd: "nested", env: {} }],
				[],
			),
		);
		expect(result.steps[0]?.stdout).toBe("nested");
		expect(native.requests[0]?.cwd).toBe(".");
	});
	it("rejects a missing artifact instead of returning an empty success", async () => {
		const native = new NativeContext(directory());
		const result = await executePipeline(
			createCloudflareBackend({
				context: native.context,
				terminate: native.terminate,
				verifyShutdown: native.verifyShutdown,
			}),
			pipeline([{ id: "ok", argv: ["true"], cwd: ".", env: {} }], ["missing"]),
		);
		expect(result.status).toBe("failed");
		expect(result.artifacts).toHaveLength(0);
		expect(native.terminations).toBe(0);
	});
	it("rejects a working-directory symlink that leaves the private source", async () => {
		const workspace = directory();
		const outside = directory();
		symlinkSync(outside, join(workspace, "nested"));
		const native = new NativeContext(workspace);
		const result = await executePipeline(
			createCloudflareBackend({
				context: native.context,
				terminate: native.terminate,
				verifyShutdown: native.verifyShutdown,
			}),
			pipeline(
				[{ id: "escape", argv: ["touch", "escaped"], cwd: "nested", env: {} }],
				[],
			),
		);
		expect(result.status).toBe("failed");
		expect(result.steps[0]?.exitCode).toBe(65);
		expect(() => readFileSync(join(outside, "escaped"))).toThrow();
	});
	it("rejects artifact symlinks leaving the bound source", async () => {
		const workspace = directory();
		const outside = directory();
		writeFileSync(join(outside, "secret"), "outside");
		symlinkSync(join(outside, "secret"), join(workspace, "link"));
		const native = new NativeContext(workspace);
		const result = await executePipeline(
			createCloudflareBackend({
				context: native.context,
				terminate: native.terminate,
				verifyShutdown: native.verifyShutdown,
			}),
			pipeline([{ id: "ok", argv: ["true"], cwd: ".", env: {} }], ["link"]),
		);
		expect(result.status).toBe("failed");
		expect(result.artifacts).toHaveLength(0);
	});
	it("rejects missing envelope fields rather than accepting protobuf defaults", async () => {
		const context: CiContext = {
			runner: async () =>
				sdkResult("{}", {
					runner: async () => {
						throw new Error("unused");
					},
				}),
		};
		const result = await executePipeline(
			createCloudflareBackend({
				context,
				terminate: async () => {},
				verifyShutdown: async () => true,
			}),
			pipeline([{ id: "ok", argv: ["true"], cwd: ".", env: {} }], []),
		);
		expect(result.status).toBe("failed");
		expect(result.steps).toHaveLength(0);
	});
	it("drains native streamed logs", async () => {
		const next: CiContext = {
			runner: async () => {
				throw new Error("unexpected extra call");
			},
		};
		const context: CiContext = {
			runner: async () =>
				sdkResult(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode(
									'{"exitCode":0,"stdoutBase64":"b2s=","stderrBase64":""}',
								),
							);
							controller.close();
						},
					}),
					next,
				),
		};
		const result = await executePipeline(
			createCloudflareBackend({
				context,
				terminate: async () => {},
				verifyShutdown: async () => true,
			}),
			pipeline([{ id: "ok", argv: ["true"], cwd: ".", env: {} }], []),
		);
		expect(result.status).toBe("succeeded");
		expect(result.steps[0]?.stdout).toBe("ok");
	});
	it("does not reinterpret malformed SDK output as command success", async () => {
		const context: CiContext = {
			runner: async () =>
				sdkResult("malformed", {
					runner: async () => {
						throw new Error("unused");
					},
				}),
		};
		const result = await executePipeline(
			createCloudflareBackend({
				context,
				terminate: async () => {},
				verifyShutdown: async () => true,
			}),
			pipeline([{ id: "ok", argv: ["true"], cwd: ".", env: {} }], []),
		);
		expect(result.status).toBe("failed");
	});
	it("waits for termination acknowledgment on cancellation", async () => {
		let stopped = false;
		let release: () => void = () => {};
		const pending = new Promise<CiRunnerResult>(() => {});
		const context: CiContext = { runner: () => pending };
		const backend = createCloudflareBackend({
			context,
			verifyShutdown: async () => stopped,
			terminate: () =>
				new Promise<void>((resolvePromise) => {
					release = () => {
						stopped = true;
						resolvePromise();
					};
				}),
		});
		const controller = new AbortController();
		const result = executePipeline(
			backend,
			pipeline([{ id: "wait", argv: ["sleep", "60"], cwd: ".", env: {} }], []),
			{ signal: controller.signal },
		);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
		controller.abort();
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
		expect(stopped).toBe(false);
		release();
		expect((await result).status).toBe("cancelled");
		expect(stopped).toBe(true);
	});
	it("does not treat a termination request alone as stopped work", async () => {
		let requested = false;
		const context: CiContext = { runner: () => new Promise(() => {}) };
		const controller = new AbortController();
		const result = executePipeline(
			createCloudflareBackend({
				context,
				terminate: async () => {
					requested = true;
				},
			}),
			pipeline([{ id: "wait", argv: ["sleep", "60"], cwd: ".", env: {} }], []),
			{ signal: controller.signal },
		);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
		controller.abort();
		expect((await result).status).toBe("uncertain");
		expect(requested).toBe(true);
	});
	it("reports uncertain shutdown if Workflow termination fails", async () => {
		const context: CiContext = { runner: () => new Promise(() => {}) };
		const controller = new AbortController();
		const result = executePipeline(
			createCloudflareBackend({
				context,
				terminate: async () => {
					throw new Error("terminate failed");
				},
			}),
			pipeline([{ id: "wait", argv: ["sleep", "60"], cwd: ".", env: {} }], []),
			{ signal: controller.signal },
		);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
		controller.abort();
		expect((await result).status).toBe("uncertain");
	});
	it("honors the actual pinned SDK timeout safety margin", () => {
		expect(() =>
			verifyNativeConfig({
				name: "old-invalid-timeout",
				command: "true",
				config: {
					retries: { limit: 0, delay: 0 },
					timeout: 31000,
					commandTimeoutMs: 30000,
				},
			}),
		).toThrow(/must not exceed/);
		expect(() =>
			verifyNativeConfig({
				name: "valid-timeout",
				command: "true",
				config: {
					retries: { limit: 0, delay: 0 },
					timeout: 40000,
					commandTimeoutMs: 30000,
				},
			}),
		).not.toThrow();
	});
	it("chunks binary artifact boundaries below the real SDK inline-log limit", async () => {
		const native = new NativeContext(directory());
		const backend = createCloudflareBackend({
			context: native.context,
			terminate: native.terminate,
			verifyShutdown: native.verifyShutdown,
		});
		const result = await executePipeline(
			backend,
			pipeline(
				[
					{
						id: "binary",
						argv: [
							process.execPath,
							"-e",
							'require("fs").writeFileSync("binary.dat",Buffer.alloc(1048576,173))',
						],
						cwd: ".",
						env: {},
					},
				],
				["binary.dat"],
			),
		);
		expect(result.status).toBe("succeeded");
		expect(result.artifacts[0]?.data).toEqual(
			new Uint8Array(1048576).fill(173),
		);
		expect(native.requests).toHaveLength(9);
		expect(native.requests.at(-1)?.name).toBe(
			"hobo-cf-contract-artifact-0-chunk-7",
		);
	}, 30000);
	it("reports output overflow as a small persisted command failure", async () => {
		const native = new NativeContext(directory());
		const result = await executePipeline(
			createCloudflareBackend({
				context: native.context,
				terminate: native.terminate,
				verifyShutdown: native.verifyShutdown,
			}),
			pipeline(
				[
					{
						id: "large",
						argv: [
							process.execPath,
							"-e",
							'process.stdout.write("x".repeat(196609))',
						],
						cwd: ".",
						env: {},
					},
				],
				[],
			),
		);
		expect(result.status).toBe("failed");
		expect(result.steps[0]?.exitCode).toBe(75);
		expect(result.steps[0]?.stderr).toContain("exceeds 192 KiB");
		expect(native.requests).toHaveLength(1);
	});

	it("keeps command names disjoint from native artifact journal keys", async () => {
		const native = new NativeContext(directory());
		const result = await executePipeline(
			createCloudflareBackend({
				context: native.context,
				terminate: native.terminate,
			}),
			pipeline([
				{
					id: "artifact-0",
					argv: ["sh", "-c", "printf actual > result.txt"],
					cwd: ".",
					env: {},
				},
			]),
		);
		expect(result.status).toBe("succeeded");
		expect(new Set(native.requests.map((request) => request.name)).size).toBe(
			2,
		);
	});

	it("quotes hostile arguments without interpolating their contents", () => {
		expect(cloudflareCommand(["printf", "' $HOME"])).toContain(
			`'printf' ''"'"' $HOME'`,
		);
	});
});
