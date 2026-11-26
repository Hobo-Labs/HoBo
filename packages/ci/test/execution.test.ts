import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	PipelineArtifactSchema,
	PipelineStepResultSchema,
} from "../src/_generated/ci_pb.js";
import {
	createArtifact,
	executePipeline,
	type PipelineBackend,
	parsePipeline,
} from "../src/execution.js";

function pipeline(extra = {}) {
	return parsePipeline(
		JSON.stringify({
			id: "build",
			accountId: "tenant",
			steps: [
				{ id: "first", argv: ["printf", "hello"], cwd: ".", env: {} },
				{ id: "second", argv: ["true"], cwd: ".", env: {} },
			],
			artifactPaths: ["out.txt"],
			timeoutSeconds: 2,
			...extra,
		}),
	);
}
it("rejects environment map keys that protobuf would silently discard", () => {
	expect(() =>
		pipeline({
			steps: [
				{
					id: "check",
					argv: ["node", "--version"],
					cwd: ".",
					env: JSON.parse('{"__proto__":"explicit-value"}'),
				},
			],
		}),
	).toThrow(/prototype/);
});
function backend() {
	const calls: string[] = [];
	const port: PipelineBackend = {
		kind: "gh-actions",
		capabilities: ["commands", "artifacts", "cancellation"],
		async open() {
			calls.push("open");
			return {
				async run(step) {
					calls.push(step.id);
					return create(PipelineStepResultSchema, {
						id: step.id,
						stdout: step.id,
						exitCode: 0,
					});
				},
				async artifact(path) {
					calls.push("artifact");
					return createArtifact(path, new TextEncoder().encode("artifact"));
				},
				async close(reason) {
					calls.push(`close:${reason}`);
				},
			};
		},
	};
	return { port, calls };
}
describe("portable execution contract", () => {
	it("preserves sequential step order and artifact integrity", async () => {
		const h = backend();
		const result = await executePipeline(h.port, pipeline());
		expect(result.status).toBe("succeeded");
		expect(result.steps.map((s) => s.stdout)).toEqual(["first", "second"]);
		expect(h.calls).toEqual([
			"open",
			"first",
			"second",
			"artifact",
			"close:completed",
		]);
		expect(new TextDecoder().decode(result.artifacts[0]?.data)).toBe(
			"artifact",
		);
		expect(result.artifacts[0]?.sha256).toHaveLength(64);
	});
	it("stops after a failed step and never collects success artifacts", async () => {
		const h = backend();
		const open = h.port.open.bind(h.port);
		h.port.open = async (p, s) => {
			const session = await open(p, s);
			session.run = async (step) =>
				create(PipelineStepResultSchema, {
					id: step.id,
					exitCode: 17,
					stderr: "expected failure",
				});
			return session;
		};
		const result = await executePipeline(h.port, pipeline());
		expect(result.status).toBe("failed");
		expect(result.steps).toHaveLength(1);
		expect(result.steps[0]?.exitCode).toBe(17);
		expect(h.calls).toEqual(["open", "close:failed"]);
	});
	it("rejects incompatible backends before allocating any resource", async () => {
		const h = backend();
		const incompatible = { ...h.port, capabilities: ["commands"] as const };
		await expect(executePipeline(incompatible, pipeline())).rejects.toThrow(
			/capabilities/,
		);
		expect(h.calls).toEqual([]);
	});
	it("requires acknowledged cleanup before reporting cancellation", async () => {
		const controller = new AbortController();
		const h = backend();
		const open = h.port.open.bind(h.port);
		h.port.open = async (p, s) => {
			const session = await open(p, s);
			session.run = async () => {
				controller.abort();
				return new Promise(() => {});
			};
			return session;
		};
		const result = await executePipeline(h.port, pipeline(), {
			signal: controller.signal,
		});
		expect(result.status).toBe("cancelled");
		expect(h.calls).toContain("close:cancelled");
	});
	it("drains a command rejection that races with synchronous cancellation", async () => {
		const controller = new AbortController();
		const h = backend();
		const open = h.port.open.bind(h.port);
		h.port.open = async (p, s) => {
			const session = await open(p, s);
			session.run = async () => {
				controller.abort();
				throw new Error("rejected after abort");
			};
			return session;
		};
		const result = await executePipeline(h.port, pipeline(), {
			signal: controller.signal,
		});
		expect(result.status).toBe("cancelled");
		await new Promise<void>((resolve) => setImmediate(resolve));
	});
	it("keeps synchronous ambiguous allocation errors uncertain", async () => {
		const h = backend();
		let allocated = 0;
		h.port.open = () => {
			allocated++;
			throw new Error("allocation response lost synchronously");
		};
		const result = await executePipeline(h.port, pipeline());
		expect(allocated).toBe(1);
		expect(result.status).toBe("uncertain");
	});
	it("freezes every executable part of the parsed input", () => {
		const parsed = pipeline();
		const step = parsed.steps[0];
		if (!step) throw new Error("fixture");
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.steps)).toBe(true);
		expect(Object.isFrozen(step.argv)).toBe(true);
		expect(Object.isFrozen(step.env)).toBe(true);
		expect(() => {
			step.argv[0] = "changed";
		}).toThrow();
		expect(() => {
			parsed.artifactPaths.push("changed");
		}).toThrow();
	});
	it("applies one MiB UTF-8 byte limits consistently to every backend", async () => {
		const h = backend();
		const open = h.port.open.bind(h.port);
		h.port.open = async (p, s) => {
			const session = await open(p, s);
			session.run = async (step) =>
				create(PipelineStepResultSchema, {
					id: step.id,
					stdout: "é".repeat(600000),
				});
			return session;
		};
		expect((await executePipeline(h.port, pipeline())).status).toBe("failed");
		expect(h.calls).toContain("close:failed");
	});
	it("keeps execution uncertain if cleanup fails", async () => {
		const h = backend();
		const open = h.port.open.bind(h.port);
		h.port.open = async (p, s) => {
			const session = await open(p, s);
			session.close = async () => {
				throw new Error("termination response lost");
			};
			return session;
		};
		expect((await executePipeline(h.port, pipeline())).status).toBe(
			"uncertain",
		);
	});
	it("detects corrupted artifact bytes from a backend", async () => {
		const h = backend();
		const open = h.port.open.bind(h.port);
		h.port.open = async (p, s) => {
			const session = await open(p, s);
			session.artifact = async (path) =>
				create(PipelineArtifactSchema, {
					path,
					data: new Uint8Array([1]),
					sha256: "0".repeat(64),
				});
			return session;
		};
		expect((await executePipeline(h.port, pipeline())).status).toBe("failed");
		expect(h.calls).toContain("close:failed");
	});
	it.each([
		"../escape",
		"/absolute",
		"dir/../escape",
		"dir\\escape",
		"dir//file",
	])("rejects unsafe artifact path %s", (path) => {
		expect(() => pipeline({ artifactPaths: [path] })).toThrow(/workspace/);
	});
	it("rejects unknown capabilities, duplicate steps and null command arguments", () => {
		expect(() => pipeline({ requiredCapabilities: ["imaginary"] })).toThrow(
			/capability/,
		);
		expect(() =>
			pipeline({
				steps: [
					{ id: "same", argv: ["a"] },
					{ id: "same", argv: ["b"] },
				],
			}),
		).toThrow(/step/);
		expect(() =>
			pipeline({ steps: [{ id: "first", argv: ["a", "bad\0arg"] }] }),
		).toThrow(/step/);
	});
});
