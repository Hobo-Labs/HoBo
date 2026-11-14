/**
 * A real `nats-server` for the integration tests: operator mode with the full
 * resolver, the system account derived from a fresh operator signing seed,
 * JetStream on and TLS required on the client listener (a throwaway CA from
 * `openssl`, trusted through `HOBO_FLEET_NATS_CA`).
 *
 * The binary is `HOBO_FLEET_NATS_SERVER_BIN`, else `nats-server` on PATH.
 * Without it, `natsServerAvailable()` is false: a suite then skips, unless
 * `CI` is set, where the integration lane provisions the binary and its
 * absence fails the suite (rule 10 of §11.3).
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenantId } from "@hobo/core";
import { createOperator, encodeOperator } from "@nats-io/jwt";
import { provisionTopology } from "../../src/bus/index.js";
import {
	mintSystemAccount,
	systemAccount,
	tenantKeys,
} from "../../src/bus/nats-jwt.js";

const decoder = new TextDecoder();

export const NATS_BINARY =
	process.env.HOBO_FLEET_NATS_SERVER_BIN ??
	(spawnSync("nats-server", ["--version"]).status === 0 ? "nats-server" : "");

/** Skip only outside CI; in CI a missing binary fails the suite. */
export const SKIP_INTEGRATION = NATS_BINARY === "" && !process.env.CI;

export function requireBinary(): void {
	if (NATS_BINARY === "")
		throw new Error(
			"nats-server is not available: set HOBO_FLEET_NATS_SERVER_BIN or put nats-server on PATH",
		);
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			// SAFETY: a TCP server listening on a host and port reports an AddressInfo.
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

function openssl(args: readonly string[], cwd: string): void {
	const result = spawnSync("openssl", [...args], { cwd, stdio: "ignore" });
	if (result.status !== 0) throw new Error(`openssl ${args[0]} failed`);
}

/** A CA and a server certificate for 127.0.0.1 and localhost. */
export type Certificates = Readonly<{ ca: string; cert: string; key: string }>;

/** Writes a throwaway CA and a server certificate signed by it into `dir`. */
export function certificates(dir: string): Certificates {
	writeFileSync(
		join(dir, "san.cnf"),
		"subjectAltName=IP:127.0.0.1,DNS:localhost\n",
	);
	openssl(
		[
			"req",
			"-x509",
			"-newkey",
			"ed25519",
			"-nodes",
			"-keyout",
			"ca.key",
			"-out",
			"ca.pem",
			"-days",
			"1",
			"-subj",
			"/CN=hobo-fleet-test-ca",
		],
		dir,
	);
	openssl(
		[
			"req",
			"-newkey",
			"ed25519",
			"-nodes",
			"-keyout",
			"server.key",
			"-out",
			"server.csr",
			"-subj",
			"/CN=localhost",
		],
		dir,
	);
	openssl(
		[
			"x509",
			"-req",
			"-in",
			"server.csr",
			"-CA",
			"ca.pem",
			"-CAkey",
			"ca.key",
			"-CAcreateserial",
			"-out",
			"server.pem",
			"-days",
			"1",
			"-extfile",
			"san.cnf",
		],
		dir,
	);
	return {
		ca: join(dir, "ca.pem"),
		cert: join(dir, "server.pem"),
		key: join(dir, "server.key"),
	};
}

export type TestNats = Readonly<{
	url: string;
	plainUrl: string;
	operatorSigningSeed: string;
	tenant: TenantId;
	provisioned: Awaited<ReturnType<typeof provisionTopology>>;
	xkeySeed: string;
	stop(): Promise<void>;
}>;

/** Starts a server and provisions one tenant on it. */
export async function startNats(tenant = "acme"): Promise<TestNats> {
	requireBinary();
	const dir = mkdtempSync(join(tmpdir(), "hobo-fleet-nats-"));
	const tls = certificates(dir);
	process.env.HOBO_FLEET_NATS_CA = tls.ca;
	const operator = createOperator();
	const signing = createOperator();
	const operatorSigningSeed = decoder.decode(signing.getSeed());
	const system = systemAccount(operatorSigningSeed).getPublicKey();
	const operatorJwt = await encodeOperator("hobo-fleet-test", operator, {
		signing_keys: [signing.getPublicKey()],
		system_account: system,
	});
	const port = await freePort();
	writeFileSync(
		join(dir, "server.conf"),
		[
			`listen: "127.0.0.1:${port}"`,
			`tls { cert_file: "${tls.cert}", key_file: "${tls.key}" }`,
			`operator: "${operatorJwt}"`,
			`system_account: "${system}"`,
			`resolver: { type: full, dir: "${join(dir, "jwt")}", allow_delete: false, interval: "2m" }`,
			`resolver_preload: { "${system}": "${await mintSystemAccount(operatorSigningSeed)}" }`,
			`jetstream { store_dir: "${join(dir, "js")}" }`,
		].join("\n"),
	);
	const server: ChildProcess = spawn(
		NATS_BINARY,
		["-c", join(dir, "server.conf")],
		{
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("nats-server did not start")),
			15_000,
		);
		server.stderr?.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("Server is ready")) {
				clearTimeout(timer);
				resolve();
			}
		});
		server.once("exit", () => reject(new Error("nats-server exited")));
	});
	// SAFETY: a literal tenant id for the tests.
	const tenantId = tenant as TenantId;
	const url = `tls://127.0.0.1:${port}`;
	const provisioned = await provisionTopology({
		servers: [url],
		operatorSigningSeed,
		tenant: tenantId,
		replicas: 1,
	});
	return {
		url,
		plainUrl: `nats://127.0.0.1:${port}`,
		operatorSigningSeed,
		tenant: tenantId,
		provisioned,
		xkeySeed: decoder.decode(
			tenantKeys(operatorSigningSeed, tenantId).xkey.getSeed(),
		),
		async stop() {
			server.kill("SIGTERM");
			await new Promise((resolve) => server.once("exit", resolve));
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
