/**
 * The isolated Sandbox's lifecycle against a stand-in Vercel Sandbox: every
 * call names the expected Session, never resumes a stopped VM, and refuses to
 * release a reservation without authoritative final usage.
 */
import { Sandbox } from "@vercel/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createIsolatedSandbox,
	discoverIsolatedSandbox,
	inspectIsolatedCommand,
	prepareIsolatedSandbox,
	sandboxCreateParameters,
	startIsolatedSandbox,
	stopIsolatedSandbox,
} from "../src/isolated-sandbox.js";
import * as bootstrap from "../src/sandbox-runner-bootstrap.js";

const NAME = "hobo-00000000-0000-4000-8000-000000000001";
const config = {
	name: NAME,
	timeoutMs: 300_000,
	vcpus: 1,
	plan: "hobby" as const,
	forwardUrl: "https://relay.example.test/sandbox/proxy",
	allowedDomains: ["github.com"],
};

/** A finished session as `listSessions` and `Session.stop` report it. */
type SessionRecord = {
	id: string;
	status: string;
	memory?: number;
	vcpus?: number;
	duration?: number;
	stoppedAt?: number;
	abortedAt?: number;
	activeCpuDurationMs?: number;
	networkTransfer?: { egress: number; ingress: number };
};

/** The running Session the stand-in VM hands out. */
type StandInSession = {
	sessionId: string;
	status: string;
	startedAt?: Date;
	timeout: number;
	getCommand?: (
		id: string,
	) => Promise<{ cmdId: string; exitCode: number | null }>;
	stop?: () => Promise<{ session: SessionRecord }>;
};

const finished = {
	id: "sbx_1",
	status: "stopped",
	memory: 2048,
	vcpus: 1,
	duration: 60_000,
	stoppedAt: 1_700_000_000_000,
	activeCpuDurationMs: 1234,
	networkTransfer: { egress: 10, ingress: 20 },
} satisfies SessionRecord;

function box(
	session: StandInSession,
	options: {
		name?: string;
		persistent?: boolean;
		sessions?: SessionRecord[];
		next?: string | null;
	} = {},
) {
	return {
		name: options.name ?? NAME,
		persistent: options.persistent ?? false,
		currentSession: () => session,
		stop: vi.fn(async () => undefined),
		listSessions: vi.fn(async () => ({
			sessions: options.sessions ?? [
				{ ...finished, status: session.status, id: session.sessionId },
			],
			pagination: { next: options.next ?? null },
		})),
	};
}
type StandInBox = ReturnType<typeof box>;

const running = (overrides: Partial<StandInSession> = {}): StandInSession => ({
	sessionId: "sbx_1",
	status: "running",
	startedAt: new Date(1_700_000_000_000),
	timeout: 300_000,
	...overrides,
});

let made: StandInBox | undefined;
let found: StandInBox | undefined;
const prepare = vi.fn(async () => undefined);
const start = vi.fn(async () => ({ commandId: "cmd_runner" }));
const get = vi.fn();
beforeEach(() => {
	made = undefined;
	found = undefined;
	get.mockClear();
	prepare.mockClear();
	start.mockClear();
	vi.spyOn(Sandbox, "create").mockImplementation(async () => {
		// SAFETY: a stand-in carrying every member isolated-sandbox.ts reads.
		return made as never;
	});
	vi.spyOn(Sandbox, "get").mockImplementation(async (params) => {
		get(params);
		// SAFETY: a stand-in carrying every member isolated-sandbox.ts reads.
		return found as never;
	});
	vi.spyOn(bootstrap, "prepareSandboxRunner").mockImplementation(prepare);
	vi.spyOn(bootstrap, "startSandboxRunner").mockImplementation(start);
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("isolated Sandbox parameters", () => {
	it("refuses a bad name, timeout, vcpu count, forward URL or region", () => {
		expect(() => sandboxCreateParameters({ ...config, name: "other" })).toThrow(
			/name/u,
		);
		expect(() =>
			sandboxCreateParameters({ ...config, timeoutMs: 46 * 60_000 }),
		).toThrow(/timeout/u);
		expect(() =>
			sandboxCreateParameters({
				...config,
				plan: "pro",
				timeoutMs: 46 * 60_000,
			}),
		).not.toThrow();
		expect(() => sandboxCreateParameters({ ...config, vcpus: 3 })).toThrow(
			/vcpu/u,
		);
		expect(() =>
			sandboxCreateParameters({ ...config, plan: "pro", vcpus: 16 }),
		).toThrow(/vcpu/u);
		expect(() =>
			sandboxCreateParameters({ ...config, plan: "enterprise", vcpus: 16 }),
		).not.toThrow();
		expect(() =>
			sandboxCreateParameters({
				...config,
				forwardUrl: "https://relay.example.test/p?x=1",
			}),
		).toThrow(/forward/u);
		expect(() =>
			sandboxCreateParameters({ ...config, region: "US-EAST" }),
		).toThrow(/region/u);
		expect(sandboxCreateParameters({ ...config, region: "iad1" }).region).toBe(
			"iad1",
		);
	});
});

describe("isolated Sandbox lifecycle", () => {
	it("creates one running session and reports its deadline", async () => {
		made = box(running());
		await expect(createIsolatedSandbox(config)).resolves.toEqual({
			name: NAME,
			sessionId: "sbx_1",
			expiresAt: 1_700_000_300_000,
		});
	});

	it("stops the VM it created when the session is wrong, not running, or has no deadline", async () => {
		const cases: [StandInBox, RegExp][] = [
			[box(running(), { persistent: true }), /persistence/u],
			[box(running({ status: "pending" })), /not running/u],
			[box(running({ startedAt: undefined })), /deadline/u],
		];
		for (const [vm, message] of cases) {
			// A failed stop never hides why the VM was refused.
			vm.stop.mockRejectedValueOnce(new Error("already gone"));
			made = vm;
			await expect(createIsolatedSandbox(config)).rejects.toThrow(message);
			expect(vm.stop).toHaveBeenCalledOnce();
		}
	});

	it("prepares and starts the runner only on the expected running session", async () => {
		found = box(running());
		await prepareIsolatedSandbox(NAME, "sbx_1");
		expect(prepare).toHaveBeenCalledOnce();
		await expect(startIsolatedSandbox(NAME, "sbx_1", "jit")).resolves.toEqual({
			commandId: "cmd_runner",
		});
		expect(get).toHaveBeenCalledWith({ name: NAME, resume: false });
		await expect(prepareIsolatedSandbox(NAME, "sbx_other")).rejects.toThrow(
			/session changed/u,
		);
		found = box(running({ status: "stopping" }));
		await expect(startIsolatedSandbox(NAME, "sbx_1", "jit")).rejects.toThrow(
			/not running/u,
		);
	});

	it("inspects a command on the running session, and reports a stopped one terminal", async () => {
		const getCommand = vi.fn(async (id: string) => ({
			cmdId: id,
			exitCode: 0,
		}));
		found = box(running({ getCommand }));
		await expect(
			inspectIsolatedCommand(NAME, "sbx_1", "cmd_1"),
		).resolves.toEqual({ commandId: "cmd_1", exitCode: 0, terminal: false });
		found = box(running({ status: "failed" }));
		await expect(
			inspectIsolatedCommand(NAME, "sbx_1", "cmd_1"),
		).resolves.toEqual({ commandId: "cmd_1", exitCode: null, terminal: true });
		found = box(running({ status: "snapshotting" }));
		await expect(
			inspectIsolatedCommand(NAME, "sbx_1", "cmd_1"),
		).rejects.toThrow(/uncertain/u);
		found = box(running(), { next: "more" });
		await expect(
			inspectIsolatedCommand(NAME, "sbx_1", "cmd_1"),
		).rejects.toThrow(/ambiguous/u);
		found = box(running(), { name: "hobo-other" });
		await expect(
			inspectIsolatedCommand(NAME, "sbx_1", "cmd_1"),
		).rejects.toThrow(/identity/u);
	});

	it("stops a running session and returns its final usage", async () => {
		const stop = vi.fn(async () => ({ session: { ...finished } }));
		found = box(running({ stop }));
		await expect(stopIsolatedSandbox(NAME, "sbx_1")).resolves.toEqual({
			cpuMs: 1234,
			egressBytes: 10,
			ingressBytes: 20,
			durationMs: 60_000,
			memoryMb: 2048,
			vcpus: 1,
			creations: 1,
			stoppedAt: 1_700_000_000_000,
		});
		expect(stop).toHaveBeenCalledOnce();
	});

	it("reads an already stopped session's usage, taking an abort time for its end", async () => {
		const { stoppedAt: _, ...aborted } = finished;
		found = box(running({ status: "aborted" }), {
			sessions: [{ ...aborted, status: "aborted", abortedAt: 5 }],
		});
		await expect(stopIsolatedSandbox(NAME, "sbx_1")).resolves.toMatchObject({
			stoppedAt: 5,
		});
	});

	it("never releases a reservation without confirmed shutdown and complete usage", async () => {
		const cases: [Partial<SessionRecord>, RegExp][] = [
			[{ status: "snapshotting" }, /unconfirmed/u],
			[{ activeCpuDurationMs: undefined }, /usage unavailable/u],
			[{ networkTransfer: { egress: -1, ingress: 0 } }, /usage unavailable/u],
			[{ duration: undefined }, /memory usage unavailable/u],
			[{ memory: 0 }, /memory usage unavailable/u],
			[{ stoppedAt: undefined }, /completion time/u],
		];
		for (const [change, message] of cases) {
			found = box(running({ status: "stopped" }), {
				sessions: [{ ...finished, ...change }],
			});
			await expect(stopIsolatedSandbox(NAME, "sbx_1")).rejects.toThrow(message);
		}
		found = box(running(), { sessions: [finished, finished] });
		await expect(stopIsolatedSandbox(NAME, "sbx_1")).rejects.toThrow(
			/ambiguous/u,
		);
		found = box(running(), { persistent: true });
		await expect(stopIsolatedSandbox(NAME, "sbx_1")).rejects.toThrow(
			/persistence/u,
		);
	});

	it("recovers an ambiguous create by name, and only when exactly one session exists", async () => {
		found = box(running());
		await expect(discoverIsolatedSandbox(NAME)).resolves.toEqual({
			sessionId: "sbx_1",
		});
		found = box(running(), { sessions: [] });
		await expect(discoverIsolatedSandbox(NAME)).rejects.toThrow(/ambiguous/u);
		found = box(running(), { persistent: true });
		await expect(discoverIsolatedSandbox(NAME)).rejects.toThrow(/persistence/u);
	});
});
