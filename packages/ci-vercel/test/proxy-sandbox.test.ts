/**
 * The trusted proxy VM's lifecycle against a stand-in Vercel Sandbox: the
 * create checks, the launch and readiness probe on the expected session, the
 * guest binding and the meter read over the proxy's own HTTPS origin.
 */
import { Sandbox } from "@vercel/sandbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	bindProxySandbox,
	createProxySandbox,
	meterProxySandbox,
	startProxySandbox,
} from "../src/proxy-sandbox.js";
import { VERCEL_SANDBOX_DRIVERS } from "../src/sandbox-composition.js";
import { ProxyStartupError } from "../src/sandbox-proxy-vm.js";

const sdk = { create: vi.fn(), get: vi.fn() };

const NAME = "hobo-proxy-00000000-0000-4000-8000-000000000001";
const LEASE = "00000000-0000-4000-8000-000000000001";
const create = {
	name: NAME,
	plan: "hobby" as const,
	region: "iad1",
	vcpus: 1,
	timeoutMs: 300_000,
	port: 8787,
	relayOrigin: "https://relay.example.test",
	domains: ["github.com"],
};
const vmConfig = {
	proxyOrigin: "https://proxy.example.test",
	relayOrigin: "https://relay.example.test",
	expectedIssuer: "https://oidc.vercel.com/team-example",
	leaseId: LEASE,
	proxySessionId: "sbx_proxy",
	quotaToken: Buffer.alloc(32, 7).toString("base64url"),
	teamId: "team_example",
	projectId: "prj_example",
	hosts: ["github.com"],
	maxEgressBytes: 1024 * 1024,
	maxControlCalls: 16,
	port: 8787,
	maxRequestBytes: 64 * 1024 * 1024,
	maxResponseBytes: 256 * 1024 * 1024,
};

type Probe = { exitCode: number; stdout: string };
/** What a case changes about the proxy's running Session. */
type SessionChange = {
	sessionId?: string;
	vcpus?: number;
	timeout?: number;
	domain?: (port: number) => string;
	getCommand?: () => Promise<{ exitCode: number | null }>;
};
function session(
	overrides: SessionChange = {},
	probe: Probe = { exitCode: 0, stdout: "" },
	commandExit: number | null = null,
) {
	return {
		sessionId: "sbx_proxy",
		status: "running",
		vcpus: 1,
		region: "iad1",
		startedAt: new Date(1_700_000_000_000),
		timeout: 300_000,
		domain: (port: number) => `https://sb-${port}.vercel.run`,
		writeFiles: vi.fn(async () => undefined),
		runCommand: vi.fn(async (options: { cmd: string; detached: boolean }) => {
			if (options.detached) return { cmdId: "cmd_proxy" };
			if (options.cmd === "mkdir") return { exitCode: 0 };
			return {
				exitCode: probe.exitCode,
				stdout: async () => {
					if (probe.stdout === "unreadable") throw new Error("gone");
					return probe.stdout;
				},
			};
		}),
		getCommand: vi.fn(async () => ({ exitCode: commandExit })),
		...overrides,
	};
}
function box(current: ReturnType<typeof session>, overrides = {}) {
	return {
		name: NAME,
		persistent: false,
		currentSession: () => current,
		stop: vi.fn(async () => undefined),
		...overrides,
	};
}

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
	sdk.create.mockReset();
	sdk.get.mockReset();
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	vi.spyOn(Sandbox, "create").mockImplementation(sdk.create);
	vi.spyOn(Sandbox, "get").mockImplementation(sdk.get);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("creating the proxy VM", () => {
	it("creates a named ephemeral VM with the relay and OIDC issuer allowed, and reports its origin", async () => {
		sdk.create.mockResolvedValue(box(session()));
		await expect(createProxySandbox(create)).resolves.toEqual({
			name: NAME,
			sessionId: "sbx_proxy",
			origin: "https://sb-8787.vercel.run",
			expiresAt: 1_700_000_300_000,
		});
		expect(sdk.create).toHaveBeenCalledWith(
			expect.objectContaining({
				persistent: false,
				ports: [8787],
				networkPolicy: {
					allow: ["github.com", "relay.example.test", "oidc.vercel.com"],
				},
			}),
		);
	});

	it("refuses bad inputs before creating anything", async () => {
		for (const change of [
			{ name: "hobo-proxy-nope" },
			{ timeoutMs: 1000 },
			{ plan: "pro" as const, vcpus: 3 },
			{ plan: "enterprise" as const, vcpus: 64 },
			{ region: "IAD" },
			{ port: 80 },
			{ relayOrigin: "https://relay.example.test/path" },
			{ domains: ["*"] },
		])
			await expect(
				createProxySandbox({ ...create, ...change }),
			).rejects.toThrow();
		expect(sdk.create).not.toHaveBeenCalled();
	});

	it("stops the VM it made when its identity, resources or endpoint are wrong", async () => {
		const cases: [ReturnType<typeof box>, RegExp][] = [
			[box(session(), { persistent: true }), /identity/u],
			[box(session({ vcpus: 2 })), /resources/u],
			[box(session({ domain: () => "http://sb.vercel.run" })), /endpoint/u],
			[box(session({ timeout: Number.MAX_SAFE_INTEGER })), /deadline/u],
		];
		for (const [made, message] of cases) {
			made.stop.mockRejectedValueOnce(new Error("already gone"));
			sdk.create.mockResolvedValue(made);
			await expect(createProxySandbox(create)).rejects.toThrow(message);
			expect(made.stop).toHaveBeenCalledOnce();
		}
	});
});

describe("starting the proxy VM", () => {
	it("launches the bundle on the expected session and waits for readiness", async () => {
		const current = session();
		sdk.get.mockResolvedValue(box(current));
		await expect(
			startProxySandbox(NAME, "sbx_proxy", vmConfig),
		).resolves.toEqual({ commandId: "cmd_proxy" });
		expect(current.writeFiles).toHaveBeenCalledOnce();
		expect(sdk.get).toHaveBeenCalledWith({ name: NAME, resume: false });
	});

	it("names the fixed startup stage when the proxy fails to come up", async () => {
		sdk.get.mockResolvedValue(
			box(session({}, { exitCode: 1, stdout: "parse_config\n" })),
		);
		const failure = startProxySandbox(NAME, "sbx_proxy", vmConfig);
		await expect(failure).rejects.toBeInstanceOf(ProxyStartupError);
		await expect(failure).rejects.toMatchObject({ reason: "parse_config" });
		sdk.get.mockResolvedValue(box(session({}, { exitCode: 1, stdout: "" }, 1)));
		await expect(
			startProxySandbox(NAME, "sbx_proxy", vmConfig),
		).rejects.toMatchObject({ reason: "process_exit" });
		// Unreadable output and missing process metadata prove nothing: a timeout.
		sdk.get.mockResolvedValue(
			box(
				session(
					{ getCommand: vi.fn(async () => Promise.reject(new Error("404"))) },
					{ exitCode: 1, stdout: "unreadable" },
				),
			),
		);
		await expect(
			startProxySandbox(NAME, "sbx_proxy", vmConfig),
		).rejects.toMatchObject({ reason: "timeout" });
	});

	it("refuses a changed or stopped session, and a VM that is not the named one", async () => {
		sdk.get.mockResolvedValue(box(session({ sessionId: "sbx_other" })));
		await expect(
			startProxySandbox(NAME, "sbx_proxy", vmConfig),
		).rejects.toThrow(/session changed/u);
		sdk.get.mockResolvedValue(box(session(), { name: "hobo-proxy-other" }));
		await expect(
			startProxySandbox(NAME, "sbx_proxy", vmConfig),
		).rejects.toThrow(/identity/u);
	});
});

describe("binding and metering the proxy", () => {
	it("binds the guest with the lease token and requires a 204", async () => {
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await bindProxySandbox("https://sb.vercel.run", "token", "sbx_guest");
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe("https://sb.vercel.run/internal/bind");
		expect(init).toMatchObject({
			method: "POST",
			redirect: "error",
			body: JSON.stringify({ sandboxId: "sbx_guest" }),
		});
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
		await expect(
			bindProxySandbox("https://sb.vercel.run", "token", "sbx_guest"),
		).rejects.toThrow(/binding unavailable/u);
		await expect(
			bindProxySandbox("http://sb.vercel.run", "token", "sbx_guest"),
		).rejects.toThrow(/invalid proxy origin/u);
	});

	it("reads the proxy's own meter from the running session's endpoint", async () => {
		sdk.get.mockResolvedValue(box(session()));
		const report = {
			leaseId: LEASE,
			proxySessionId: "sbx_proxy",
			bytes: 42,
			calls: 3,
		};
		fetchMock.mockResolvedValueOnce(Response.json(report));
		await expect(
			meterProxySandbox(NAME, "sbx_proxy", 8787, "token"),
		).resolves.toEqual(report);
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://sb-8787.vercel.run/internal/meter",
		);
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
		await expect(
			meterProxySandbox(NAME, "sbx_proxy", 8787, "token"),
		).rejects.toThrow(/meter unavailable/u);
		fetchMock.mockResolvedValueOnce(Response.json({ ...report, extra: 1 }));
		await expect(
			meterProxySandbox(NAME, "sbx_proxy", 8787, "token"),
		).rejects.toThrow();
		sdk.get.mockResolvedValue(
			box(session({ domain: () => "https://sb.vercel.run/path" })),
		);
		await expect(
			meterProxySandbox(NAME, "sbx_proxy", 8787, "token"),
		).rejects.toThrow(/endpoint/u);
	});

	it("reads the meter on the port the deployed proxy listens on", async () => {
		sdk.get.mockResolvedValue(box(session()));
		fetchMock.mockResolvedValueOnce(
			Response.json({
				leaseId: LEASE,
				proxySessionId: "sbx_proxy",
				bytes: 0,
				calls: 0,
			}),
		);
		await VERCEL_SANDBOX_DRIVERS.proxyDriver.meter(NAME, "sbx_proxy", "token");
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://sb-3000.vercel.run/internal/meter",
		);
	});
});
