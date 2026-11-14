/**
 * The proxy VM's process entry, over a stand-in filesystem and server: it
 * consumes the one-time config and nonce, refuses a second start, and leaves
 * only a fixed failure stage behind — never configuration or exception text.
 */
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONFIG = "/vercel/sandbox/.hobo-ci-proxy-config.json";
const NONCE = "/vercel/sandbox/.hobo-ci-proxy-nonce";
const READY = "/vercel/sandbox/.hobo-ci-proxy-ready";
const FAILURE = "/vercel/sandbox/.hobo-ci-proxy-failure";
const nonce = "0123456789abcdef0123456789abcdef";
const proxyConfig = JSON.stringify({
	proxyOrigin: "https://proxy.example.test",
	relayOrigin: "https://relay.example.test",
	expectedIssuer: "https://oidc.vercel.com/team-example",
	leaseId: "00000000-0000-4000-8000-000000000001",
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
});

/** The VM's files, as the stand-in filesystem holds them. */
const unlinked: string[] = [];
const disk = {
	files: new Map<string, string>(),
	written: new Map<string, string>(),
	unlinked,
	markerTaken: false,
	failWrite: false,
};

/** The stand-in listener the entry starts. */
class StandInServer extends EventEmitter {
	readonly listen = vi.fn();
}
let server: StandInServer | undefined;
let fatal: (() => Promise<void>) | undefined;

/** Run the entry once, as a fresh process would. */
async function start() {
	vi.resetModules();
	const vm = await import("../src/sandbox-proxy-vm.js");
	vi.spyOn(vm, "createSandboxProxyVmServer").mockImplementation(() => {
		server = new StandInServer();
		// SAFETY: the entry calls only once("listening") and listen(port, host),
		// which the stand-in carries.
		return server as never;
	});
	vi.spyOn(vm, "installProxyFatalErrorHandler").mockImplementation(
		(_server, report) => {
			fatal = report;
		},
	);
	await import("../src/sandbox-proxy-vm-entry.js");
}

let stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	disk.files.clear();
	disk.written.clear();
	disk.unlinked.length = 0;
	disk.markerTaken = false;
	disk.failWrite = false;
	server = undefined;
	fatal = undefined;
	vi.spyOn(fsp, "open").mockImplementation(async () => {
		if (disk.markerTaken) throw new Error("EEXIST");
		disk.markerTaken = true;
		// SAFETY: the entry only closes the marker handle it opened.
		return { close: async () => undefined } as never;
	});
	vi.spyOn(fsp, "readFile").mockImplementation(async (path) => {
		const value = disk.files.get(String(path));
		if (value === undefined) throw new Error("ENOENT");
		return value;
	});
	vi.spyOn(fsp, "unlink").mockImplementation(async (path) => {
		disk.unlinked.push(String(path));
		if (!disk.files.delete(String(path))) throw new Error("ENOENT");
	});
	vi.spyOn(fsp, "writeFile").mockImplementation(async (path, data) => {
		if (disk.failWrite) throw new Error("EROFS");
		disk.written.set(String(path), String(data));
	});
	syncBuiltinESMExports();
	stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	process.exitCode = undefined;
});

describe("the proxy VM entry", () => {
	it("consumes the config and nonce, listens, and writes the nonce once listening", async () => {
		disk.files.set(CONFIG, proxyConfig);
		disk.files.set(NONCE, nonce);
		await start();
		expect(disk.files.has(CONFIG)).toBe(false);
		expect(disk.files.has(NONCE)).toBe(false);
		expect(server?.listen).toHaveBeenCalledWith(8787, "0.0.0.0");
		server?.emit("listening");
		await vi.waitFor(() => expect(disk.written.get(READY)).toBe(nonce));
		expect(process.exitCode).toBeUndefined();
	});

	it("exits when the readiness marker cannot be written", async () => {
		disk.files.set(CONFIG, proxyConfig);
		disk.files.set(NONCE, nonce);
		// SAFETY: process.exit never returns; the stand-in only records the call.
		const exit = vi
			.spyOn(process, "exit")
			.mockImplementation(() => undefined as never);
		await start();
		disk.failWrite = true;
		server?.emit("listening");
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
		expect(process.exitCode).toBe(1);
	});

	it("records only the listen stage when the listener fails", async () => {
		disk.files.set(CONFIG, proxyConfig);
		disk.files.set(NONCE, nonce);
		await start();
		await fatal?.();
		expect(disk.written.get(FAILURE)).toBe("listen");
		expect(process.exitCode).toBe(1);
	});

	it("refuses a second start in the same VM at the marker stage", async () => {
		disk.markerTaken = true;
		await start();
		expect(disk.written.get(FAILURE)).toBe("marker");
		expect(process.exitCode).toBe(1);
		const line = String(stderr.mock.calls[0]?.[0]);
		expect(JSON.parse(line)).toEqual({
			event: "hobo_ci_proxy_start_failure",
			stage: "marker",
		});
	});

	it("fails at read_config when the config is missing", async () => {
		await start();
		expect(disk.written.get(FAILURE)).toBe("read_config");
		expect(disk.unlinked).toEqual([CONFIG, NONCE]);
	});

	it("fails at parse_config, without the config's text, and still deletes it", async () => {
		disk.files.set(CONFIG, JSON.stringify({ secret: "bad config secret" }));
		disk.files.set(NONCE, nonce);
		await start();
		expect(disk.written.get(FAILURE)).toBe("parse_config");
		expect(String(stderr.mock.calls[0]?.[0])).not.toContain("secret");
		expect(disk.files.size).toBe(0);
		disk.markerTaken = false;
		disk.files.set(CONFIG, proxyConfig);
		disk.files.set(NONCE, "not-a-nonce");
		await start();
		expect(disk.written.get(FAILURE)).toBe("parse_config");
	});

	it("still exits nonzero when even the failure marker cannot be written", async () => {
		disk.failWrite = true;
		stderr.mockImplementation(() => {
			throw new Error("closed");
		});
		await start();
		expect(process.exitCode).toBe(1);
	});
});
