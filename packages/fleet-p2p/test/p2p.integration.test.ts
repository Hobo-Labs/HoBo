/**
 * O12 for `p2p` (design §10.1): `runTransportConformance` between two
 * transports from `createP2pTransport`, reaching each other only through the
 * iroh relay the integration lane provisions (`iroh-relay` on PATH, or
 * `HOBO_FLEET_IROH_RELAY_BIN`), run in its plain-HTTP development mode on a
 * loopback port. The transports have no direct address book and no discovery:
 * they find each other by endpoint id at the relay, as devices do.
 *
 * Rule 10 (§11.3): with `CI` set, a missing relay binary fails; otherwise the
 * suite skips. Where the platform has no prebuilt binding (A8 failed), the
 * file asserts instead that the adapter reports itself unavailable.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
	accessSync,
	constants,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { type AddressInfo, createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { SESSION_GRANT_CONTEXT, SignedEnvelopeSchema } from "@hobo/fleet";
import { runTransportConformance } from "@hobo/fleet/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createP2pTransport } from "../src/index.js";
import { loadIroh } from "../src/iroh.js";
import { createTestDeviceKeys } from "./support/device-keys.js";

const STARTUP_MS = 20_000;

function executable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function findRelayBinary(): string | undefined {
	const configured = process.env.HOBO_FLEET_IROH_RELAY_BIN;
	if (configured !== undefined && configured !== "") return configured;
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = join(directory, "iroh-relay");
		if (directory !== "" && executable(candidate)) return candidate;
	}
	return undefined;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			// SAFETY: a TCP server listening on a host and port answers an AddressInfo.
			const port = (server.address() as AddressInfo).port;
			server.close(() => resolve(port));
		});
	});
}

function reachable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = new Socket();
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
		socket.connect(port, "127.0.0.1");
	});
}

/** Starts the relay in development mode on a loopback port; answers its URL. */
async function startRelay(
	binary: string,
	directory: string,
): Promise<Readonly<{ url: string; child: ChildProcess }>> {
	const port = await freePort();
	const config = join(directory, "iroh-relay.toml");
	writeFileSync(
		config,
		[
			"enable_relay = true",
			`http_bind_addr = "127.0.0.1:${port}"`,
			"enable_quic_addr_discovery = false",
			"enable_metrics = false",
			"",
		].join("\n"),
	);
	const child = spawn(binary, ["--dev", "--config-path", config], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const deadline = Date.now() + STARTUP_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null)
			throw new Error(`iroh-relay exited with ${child.exitCode}: ${stderr}`);
		if (await reachable(port))
			return { url: `http://127.0.0.1:${port}/`, child };
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	child.kill("SIGKILL");
	throw new Error(
		`iroh-relay did not listen on ${port} within ${STARTUP_MS} ms: ${stderr}`,
	);
}

const binding = loadIroh();
const relayBinary = findRelayBinary();
const inCi = (process.env.CI ?? "") !== "" && process.env.CI !== "false";

if (binding === undefined) {
	describe("[A8] p2p on a platform without a prebuilt binding", () => {
		it("[A8] reports itself unavailable", async () => {
			const transport = createP2pTransport({
				relayUrls: ["https://relay.fleet.example/"],
			});
			const { transportIdentity } = await transport.start(
				createTestDeviceKeys(),
			);
			expect(transportIdentity).toBe("");
			const outcome = await transport.dial({
				grant: create(SignedEnvelopeSchema, { context: SESSION_GRANT_CONTEXT }),
				signal: new AbortController().signal,
			});
			expect(outcome.ok ? "carried" : outcome.error.code).toBe("unavailable");
			await transport.stop();
		});
	});
} else if (relayBinary === undefined && inCi) {
	describe("[A8] p2p through the provisioned iroh relay", () => {
		it("[A8] finds the provisioned iroh-relay binary", () => {
			throw new Error(
				"iroh-relay is not on PATH and HOBO_FLEET_IROH_RELAY_BIN is unset; the integration lane provisions it",
			);
		});
	});
} else {
	describe.skipIf(relayBinary === undefined)(
		"[A8] p2p through the provisioned iroh relay",
		() => {
			let relayUrl = "";
			let relayChild: ChildProcess | undefined;
			let relayDirectory = "";
			beforeAll(async () => {
				if (relayBinary === undefined) return;
				relayDirectory = mkdtempSync(join(tmpdir(), "hobo-iroh-relay-"));
				const relay = await startRelay(relayBinary, relayDirectory);
				relayUrl = relay.url;
				relayChild = relay.child;
			}, STARTUP_MS + 5_000);
			afterAll(() => {
				relayChild?.kill("SIGTERM");
				if (relayDirectory !== "")
					rmSync(relayDirectory, { recursive: true, force: true });
			});
			runTransportConformance(async () => [
				createP2pTransport({ relayUrls: [relayUrl] }),
				createP2pTransport({ relayUrls: [relayUrl] }),
			]);
		},
	);
}
