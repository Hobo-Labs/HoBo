import { describe, expect, it } from "vitest";
import { SandboxTier, WorkOrigin } from "../../../src/_generated/fleet_pb.js";
import type { ObservedAssignment, Sandbox } from "../../../src/ports.js";
import { createFakeSandboxDriver } from "../../../src/testing/plumbing/fake-sandbox.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function createInput(
	orderId: string,
	fence: (observed: ObservedAssignment) => Promise<boolean>,
) {
	return {
		orderId,
		image: "busybox",
		limits: { memoryMb: 512, cpus: 1, pids: 64, diskMb: 1024 },
		egressProxyUrl: "http://proxy.invalid:3128",
		readOnlyMounts: [],
		hostDocker: false,
		fence,
	};
}

async function postFence(sandbox: Sandbox, body: string) {
	const output: string[] = [];
	const result = await sandbox.exec({
		argv: ["curl", "-sS", "--data-binary", "@-", `${sandbox.controlUrl}/fence`],
		env: {},
		stdin: encoder.encode(body),
		signal: new AbortController().signal,
		onOutput: (chunk) => output.push(decoder.decode(chunk)),
	});
	return { exitCode: result.exitCode, output: output.join("") };
}

const internalJob: ObservedAssignment = {
	workKey: "job-1",
	repository: "hobo-labs/hobo",
	ref: "refs/heads/main",
	author: "octocat",
	origin: WorkOrigin.INTERNAL,
};

describe("createFakeSandboxDriver", () => {
	it("is available at its tier without Docker", async () => {
		const driver = createFakeSandboxDriver(SandboxTier.S1_CONTAINER);
		expect(driver.tier).toBe(SandboxTier.S1_CONTAINER);
		expect(await driver.available()).toEqual({
			ok: true,
			value: { providesDocker: false },
		});
	});

	it("records what it is asked to run, never secrets", async () => {
		const driver = createFakeSandboxDriver(SandboxTier.S1_CONTAINER);
		const sandbox = await driver.create(
			createInput("order-1", async () => true),
		);
		expect(sandbox.tier).toBe(SandboxTier.S1_CONTAINER);
		await sandbox.writeSecret("/run/secret", encoder.encode("hunter2"));
		const result = await sandbox.exec({
			argv: ["./run.sh", "--once"],
			env: { CI: "1" },
			signal: new AbortController().signal,
			onOutput: () => {},
		});
		expect(result.exitCode).toBe(0);
		expect(driver.runs).toEqual(["./run.sh --once"]);
		expect(driver.runs.join("\n")).not.toContain("hunter2");
	});

	it("answers the fence on controlUrl through its callback", async () => {
		const seen: ObservedAssignment[] = [];
		const driver = createFakeSandboxDriver(SandboxTier.S1_CONTAINER);
		const sandbox = await driver.create(
			createInput("order-1", async (observed) => {
				seen.push(observed);
				return observed.origin === WorkOrigin.INTERNAL;
			}),
		);
		expect(await postFence(sandbox, JSON.stringify(internalJob))).toEqual({
			exitCode: 0,
			output: '{"allow":true}',
		});
		expect(
			await postFence(
				sandbox,
				JSON.stringify({ ...internalJob, origin: "WORK_ORIGIN_FORK" }),
			),
		).toEqual({ exitCode: 1, output: '{"allow":false}' });
		expect(seen.map((o) => o.origin)).toEqual([
			WorkOrigin.INTERNAL,
			WorkOrigin.FORK,
		]);
	});

	it("refuses unreadable fence facts without asking the callback", async () => {
		let asked = 0;
		const driver = createFakeSandboxDriver(SandboxTier.S1_CONTAINER);
		const sandbox = await driver.create(
			createInput("order-1", async () => {
				asked += 1;
				return true;
			}),
		);
		expect((await postFence(sandbox, "not json")).output).toBe(
			'{"allow":false}',
		);
		expect(
			(await postFence(sandbox, JSON.stringify({ workKey: "job-1" }))).output,
		).toBe('{"allow":false}');
		expect(asked).toBe(0);
	});

	it("is single use: one sandbox per order, nothing after destroy, destroy idempotent", async () => {
		const driver = createFakeSandboxDriver(SandboxTier.S1_CONTAINER);
		const sandbox = await driver.create(
			createInput("order-1", async () => true),
		);
		await expect(
			driver.create(createInput("order-1", async () => true)),
		).rejects.toThrow(/order-1/);
		const other = await driver.create(createInput("order-2", async () => true));
		expect(other.id).not.toBe(sandbox.id);
		expect(other.controlUrl).not.toBe(sandbox.controlUrl);

		await sandbox.destroy();
		await sandbox.destroy();
		await expect(
			sandbox.exec({
				argv: ["true"],
				env: {},
				signal: new AbortController().signal,
				onOutput: () => {},
			}),
		).rejects.toThrow(/destroyed/);
		await expect(sandbox.writeSecret("/s", new Uint8Array())).rejects.toThrow(
			/destroyed/,
		);
	});
});
