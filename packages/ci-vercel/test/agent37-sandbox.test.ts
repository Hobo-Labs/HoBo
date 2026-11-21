import { createAgent37Client } from "@hobo/provider-agent37";
import {
	createAgent37FakeServer,
	type FakeAgent37ExecHandler,
	type FakeAgent37Server,
} from "@hobo/provider-agent37/fake";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAgent37SandboxDriver,
	parseAgent37NetworkAllow,
	resolveAgent37Network,
} from "../src/agent37-sandbox.js";
import type { IsolatedSandboxConfiguration } from "../src/isolated-sandbox.js";
import { createAgent37SandboxDrivers } from "../src/sandbox-composition.js";

const leaseId = "00000000-0000-4000-8000-000000000001";
const name = `hobo-${leaseId}`;
const now = Date.parse("2026-10-27T12:00:00Z");
const configuration: IsolatedSandboxConfiguration = {
	name,
	timeoutMs: 600_000,
	vcpus: 2,
	plan: "hobby",
	forwardUrl: "https://ci.example.com/sandbox/egress",
	allowedDomains: ["github.com"],
};
const pool = {
	template: "agent37-ubuntu",
	type: "vm" as const,
	region: "us" as const,
	cpu: 2,
	memory: 4,
	disk: 20,
	network: { allow: ["github.com"] },
};
const servers: FakeAgent37Server[] = [];

async function fixture(execHandler?: FakeAgent37ExecHandler) {
	const fake =
		execHandler === undefined
			? await createAgent37FakeServer({ now: () => new Date(now) })
			: await createAgent37FakeServer({
					now: () => new Date(now),
					execHandler,
				});
	servers.push(fake);
	const fetchImpl: typeof globalThis.fetch = async (input, init) => {
		const source = new URL(new Request(input).url);
		expect([
			"https://api.agent37.com",
			"https://sandbox.agent37.app",
		]).toContain(source.origin);
		return fetch(`${fake.baseUrl}${source.pathname}${source.search}`, init);
	};
	const client = createAgent37Client({
		apiKey: fake.apiKey,
		fetchImpl,
		sleep: async () => {},
		random: () => 0,
	});
	const driver = createAgent37SandboxDriver({
		client,
		pool,
		now: () => now + 60_000,
	});
	return { client, driver, fake };
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("Agent37 network allowlists", () => {
	it.each([
		{ label: "missing", network: undefined },
		{ label: "allow all", network: "allow-all" as const },
		{ label: "deny all", network: "deny-all" as const },
		{ label: "empty", network: { allow: [] } },
	])("rejects $label network configuration", ({ network }) => {
		expect(() => resolveAgent37Network({ ...pool, network })).toThrow();
	});

	it.each([
		"https://github.com",
		"github.com/path",
		"github..com",
		"-github.com",
		"github-.com",
		"git_hub.com",
		"*",
		"*.",
		"*.com",
		"*.co.uk",
		"*.github.io",
		"GitHub.com",
		"127.0.0.1",
	])("rejects non-hostname or overly broad entry %s", (entry) => {
		expect(() => parseAgent37NetworkAllow([entry])).toThrow(
			/invalid or repeated/,
		);
	});

	it("rejects duplicates and more than 100 entries", () => {
		expect(() =>
			parseAgent37NetworkAllow(["github.com", "github.com"]),
		).toThrow(/repeated/);
		expect(() =>
			parseAgent37NetworkAllow(
				Array.from({ length: 101 }, (_, index) => `host${index}.example.com`),
			),
		).toThrow(/1-100/);
	});

	it("copies valid exact and leading-wildcard hostnames without rewriting them", () => {
		const entries = ["github.com", "*.actions.githubusercontent.com"];
		const resolved = parseAgent37NetworkAllow(entries);
		entries[0] = "api.github.com";
		expect(resolved).toEqual(["github.com", "*.actions.githubusercontent.com"]);
	});
});

describe("Agent37 sandbox lifecycle", () => {
	it("creates and discovers an isolated instance with lease-bound configuration", async () => {
		const { driver, fake } = await fixture();
		const created = await driver.create(configuration);
		const instance = fake.state.instances[0];
		expect(instance).toMatchObject({
			name,
			template: "agent37-ubuntu",
			type: "vm",
			region: "us",
			resources: { cpu: 2, memoryGb: 4, diskGb: 20 },
			autoSleep: false,
			metadata: { hobo: "ci", leaseId },
			env: { HOBO_LEASE_ID: leaseId },
			network: { allow: ["github.com"] },
		});
		expect(created).toEqual({
			name,
			sessionId: instance?.id,
			expiresAt: now + 660_000,
		});
		await expect(driver.discover(name)).resolves.toEqual({
			sessionId: instance?.id,
		});
		await expect(driver.create(configuration)).resolves.toEqual(created);
		expect(fake.state.instances).toHaveLength(1);
	});

	it("preserves Agent37 leading-wildcard matching configuration", async () => {
		const { client, fake } = await fixture();
		const driver = createAgent37SandboxDriver({
			client,
			pool: {
				...pool,
				network: { allow: ["*.actions.githubusercontent.com"] },
			},
		});
		await driver.create(configuration);
		expect(fake.state.instances[0]?.network).toEqual({
			allow: ["*.actions.githubusercontent.com"],
		});
	});

	it("refuses to adopt an existing instance whose state changed", async () => {
		const { driver, fake } = await fixture();
		await driver.create(configuration);
		const instance = fake.state.instances[0];
		if (!instance) throw new Error("instance missing");
		instance.status = "failed";
		await expect(driver.create(configuration)).rejects.toThrow(
			/does not match/,
		);
	});

	it("fails discovery when no matching instance exists", async () => {
		const { driver } = await fixture();
		await expect(driver.discover(name)).rejects.toThrow(/not found/);
	});

	it("refuses discovery when an instance no longer matches the pool contract", async () => {
		const { driver, fake } = await fixture();
		await driver.create(configuration);
		const instance = fake.state.instances[0];
		if (!instance) throw new Error("instance missing");
		instance.template = "agent37-evil@9";
		await expect(driver.discover(name)).rejects.toThrow(/does not match/);
	});

	it("prepares the pinned runner archive as root with an idempotency name", async () => {
		const { driver, fake } = await fixture();
		await driver.create(configuration);
		await driver.prepare(name, fake.state.instances[0]?.id ?? "");
		const invocation = fake.state.execInvocations[0];
		expect(invocation).toMatchObject({
			name: `prep-${leaseId}`,
			user: "root",
			background: false,
		});
		expect(invocation?.command).toContain("sha256sum --check --status");
	});

	it("fails preparation on a nonzero exec result", async () => {
		const { driver, fake } = await fixture(() => ({
			stdout: "",
			stderr: "failed",
			exitCode: 1,
		}));
		await driver.create(configuration);
		await expect(
			driver.prepare(name, fake.state.instances[0]?.id ?? ""),
		).rejects.toThrow(/preparation failed/);
	});

	it("stages the JIT separately and starts a scrubbed background runner", async () => {
		const { driver, fake } = await fixture();
		await driver.create(configuration);
		const sessionId = fake.state.instances[0]?.id ?? "";
		await driver.prepare(name, sessionId);
		const jit = "b25lLXRpbWU=";
		const started = await driver.start(name, sessionId, jit);
		expect(started.cmdId).toMatch(/^ex_/);
		expect(fake.state.execInvocations.map((entry) => entry.name)).toEqual([
			`prep-${leaseId}`,
			`jit-${leaseId}`,
			`start-${leaseId}`,
		]);
		const staged = fake.state.execInvocations[1];
		const startedInvocation = fake.state.execInvocations[2];
		expect(staged?.command).toContain(jit);
		expect(staged?.env).not.toHaveProperty("AGENT37_API_KEY");
		expect(startedInvocation).toMatchObject({ background: true, user: "root" });
		const startRequest = JSON.stringify(startedInvocation);
		for (const secret of [
			"AGENT37_API_KEY",
			fake.apiKey,
			jit,
			Buffer.from(jit, "base64").toString("utf8"),
		]) {
			expect(startRequest).not.toContain(secret);
		}
		expect(startedInvocation?.command).toContain("env -i");
	});

	it.each([
		"",
		"not-base64!",
		"abc",
	])("rejects invalid JIT payload %j before exec", async (jit) => {
		const { driver, fake } = await fixture();
		await driver.create(configuration);
		await expect(
			driver.start(name, fake.state.instances[0]?.id ?? "", jit),
		).rejects.toThrow(/invalid runner JIT/);
		expect(fake.state.execInvocations).toHaveLength(0);
	});

	it.each([
		{ output: "running\n", exitCode: null, terminal: false },
		{ output: "exit:0\n", exitCode: 0, terminal: true },
		{ output: "exit:17\n", exitCode: 17, terminal: true },
		{ output: "gone\n", exitCode: null, terminal: true },
		{ output: "unexpected\n", exitCode: null, terminal: true },
		{ output: "exit:invalid\n", exitCode: null, terminal: true },
	])("maps inspection output $output to a non-success terminal state when appropriate", async ({
		output,
		exitCode,
		terminal,
	}) => {
		const { driver, fake } = await fixture(() => ({
			stdout: output,
			stderr: "",
			exitCode: 0,
		}));
		await driver.create(configuration);
		await expect(
			driver.inspect(name, fake.state.instances[0]?.id ?? "", "cmd"),
		).resolves.toEqual({ commandId: "cmd", exitCode, terminal });
	});

	it("deletes the instance and reports measured creation and runtime usage", async () => {
		const { driver, fake } = await fixture();
		const created = await driver.create(configuration);
		await driver.create(configuration);
		const usage = await driver.stop(name, created.sessionId);
		expect(fake.state.instances).toHaveLength(0);
		expect(usage).toEqual({
			cpuMs: 120_000,
			durationMs: 60_000,
			memoryMb: 4096,
			vcpus: 2,
			egressBytes: 0,
			ingressBytes: 0,
			creations: 1,
			stoppedAt: now + 60_000,
		});
	});

	it("uses composition domains instead of the pool's previous network", async () => {
		const {
			client,
			pool: initialPool,
			fake,
		} = await fixture().then((value) => ({
			...value,
			pool,
		}));
		const drivers = createAgent37SandboxDrivers({ client, pool: initialPool }, [
			"api.github.com",
			"*.actions.githubusercontent.com",
		]);
		await drivers.driver.create(configuration);
		expect(fake.state.instances[0]?.network).toEqual({
			allow: ["api.github.com", "*.actions.githubusercontent.com"],
		});
	});
});
