import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { PipelineStepSchema } from "../src/_generated/ci_pb.js";
import { executePipeline, parsePipeline } from "../src/execution.js";
import { createScriptedPipelineBackend } from "../src/testing.js";

function pipeline() {
	return parsePipeline(
		JSON.stringify({
			id: "build",
			accountId: "tenant",
			timeoutSeconds: 3,
			steps: [
				{ id: "compile", argv: ["must-not-execute"], cwd: ".", env: {} },
				{ id: "test", argv: ["must-not-execute"], cwd: ".", env: {} },
			],
			artifactPaths: ["out.txt"],
		}),
	);
}

describe("scripted pipeline backend", () => {
	it("records portable execution and returns isolated scripted artifacts", async () => {
		const bytes = new TextEncoder().encode("fixture artifact");
		const backend = createScriptedPipelineBackend({
			kind: "dagger",
			run: (step) => ({ stdout: step.id }),
			artifact: () => bytes,
		});
		const other = createScriptedPipelineBackend({ kind: "cf" });
		expect(backend.fidelity).toBe("mocked");
		const result = await executePipeline(backend.port, pipeline());
		expect(result.status).toBe("succeeded");
		expect(result.steps.map((step) => step.stdout)).toEqual([
			"compile",
			"test",
		]);
		expect(new TextDecoder().decode(result.artifacts[0]?.data)).toBe(
			"fixture artifact",
		);
		expect(result.artifacts[0]?.sha256).toHaveLength(64);
		expect(backend.calls).toEqual([
			{ operation: "open", pipelineId: "build" },
			{ operation: "run", stepId: "compile" },
			{ operation: "run", stepId: "test" },
			{ operation: "artifact", path: "out.txt" },
			{ operation: "close", reason: "completed" },
		]);
		const snapshot = backend.calls;
		Object.assign(snapshot[0] ?? {}, { pipelineId: "changed" });
		expect(backend.calls[0]).toEqual({
			operation: "open",
			pipelineId: "build",
		});
		if (result.artifacts[0]) result.artifacts[0].data[0] = 0;
		expect(new TextDecoder().decode(bytes)).toBe("fixture artifact");
		expect(other.calls).toEqual([]);
		backend.clear();
		expect(backend.calls).toEqual([]);
	});

	it("cancels an in-flight scripted command before closing the session", async () => {
		let started: () => void = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const controller = new AbortController();
		const backend = createScriptedPipelineBackend({
			kind: "gh-actions",
			run: (_step, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
					started();
				}),
		});
		const result = executePipeline(backend.port, pipeline(), {
			signal: controller.signal,
		});
		await running;
		controller.abort();
		expect((await result).status).toBe("cancelled");
		expect(backend.calls.at(-1)).toEqual({
			operation: "close",
			reason: "cancelled",
		});
	});

	it("treats an unscripted artifact as missing", async () => {
		const backend = createScriptedPipelineBackend({ kind: "cf" });
		const result = await executePipeline(backend.port, pipeline());
		expect(result.status).toBe("failed");
		expect(result.steps.map((step) => step.exitCode)).toEqual([0, 0]);
		expect(backend.calls.at(-1)).toEqual({
			operation: "close",
			reason: "failed",
		});
	});

	it("captures a step before callers can mutate it", async () => {
		const backend = createScriptedPipelineBackend({
			kind: "gh-actions",
			run: (step) => ({ stdout: step.id }),
		});
		const session = await backend.port.open(
			pipeline(),
			new AbortController().signal,
		);
		const step = create(PipelineStepSchema, { id: "original" });
		const pending = session.run(step, new AbortController().signal);
		step.id = "changed";
		expect(await pending).toMatchObject({ id: "original", stdout: "original" });
		expect(backend.calls.at(-1)).toEqual({
			operation: "run",
			stepId: "original",
		});
		await session.close("completed");
	});

	it("rejects unsafe artifact paths before invoking the scripted handler", async () => {
		const seen: string[] = [];
		const backend = createScriptedPipelineBackend({
			kind: "cf",
			artifact(path) {
				seen.push(path);
				return new Uint8Array();
			},
		});
		const signal = new AbortController().signal;
		const session = await backend.port.open(pipeline(), signal);
		for (const path of ["../outside", "/absolute", "dir/../outside"]) {
			await expect(session.artifact(path, signal)).rejects.toThrow(
				"inside source workspace",
			);
		}
		expect(seen).toEqual([]);
		expect((await session.artifact("out.txt", signal)).path).toBe("out.txt");
		expect(seen).toEqual(["out.txt"]);
		await session.close("completed");
	});

	it("waits for pending work to settle before acknowledging close", async () => {
		let finish: () => void = () => {};
		let started: () => void = () => {};
		let reenter: () => void = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		let closed = false;
		const backend = createScriptedPipelineBackend({
			kind: "ado",
			run: async (_step, signal) => {
				signal.addEventListener("abort", () => reenter(), { once: true });
				started();
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return {};
			},
			close: () => {
				closed = true;
			},
		});
		const session = await backend.port.open(
			pipeline(),
			new AbortController().signal,
		);
		reenter = () => {
			void session.close("cancelled");
		};
		const operation = session.run(
			create(PipelineStepSchema, { id: "slow" }),
			new AbortController().signal,
		);
		const rejected = operation.then(
			() => false,
			() => true,
		);
		await running;
		const close = session.close("cancelled");
		expect(closed).toBe(false);
		await expect(
			session.run(
				create(PipelineStepSchema, { id: "late" }),
				new AbortController().signal,
			),
		).rejects.toThrow("closed");
		finish();
		expect(await rejected).toBe(true);
		await close;
		expect(closed).toBe(true);
		await session.close("cancelled");
		expect(
			backend.calls.filter((call) => call.operation === "close"),
		).toHaveLength(1);
	});
});
