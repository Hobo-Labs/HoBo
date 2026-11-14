/**
 * The acceptance world's bus on a real `nats-server` (O2's integration half,
 * design §10.1): operator mode with the full resolver, JetStream and TLS from
 * a throwaway `openssl` CA (trusted through `HOBO_FLEET_NATS_CA`); the tenant
 * provisioned with `provisionTopology`; the authority's bus from
 * `connectAuthorityBus`; the auth callout from `startCalloutResponder`; and
 * devices connecting as themselves with `createNatsBusConnector`, presenting
 * the session tickets the authority's credential route signs.
 *
 * Starting a server needs an operator JWT naming the system account that
 * `provisionTopology` pushes account JWTs through, and the callout needs the
 * tenant's callout xkey seed. `@hobo/fleet-nats` derives both from the
 * operator signing seed (HKDF-SHA-256, `hobo-fleet/nats/<scope>`) and exports
 * no helper for a test server, so this file derives them the same way and
 * writes the two JWTs with `node:crypto` (as `@hobo/ci-gh-actions`'s O24 test
 * support does; a public `@hobo/fleet-nats` test server would replace both).
 *
 * The binary is `HOBO_FLEET_NATS_SERVER_BIN`, else `nats-server` on PATH.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTenantId } from "@hobo/core";
import { connectAuthorityBus, createNatsBusConnector, provisionTopology, startCalloutResponder } from "@hobo/fleet-nats";
import type { BusProvider } from "./world.js";

export const NATS_BINARY =
	process.env.HOBO_FLEET_NATS_SERVER_BIN ?? (spawnSync("nats-server", ["--version"]).status === 0 ? "nats-server" : "");

const encoder = new TextEncoder();
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ROLE = { seed: 18 << 3, operator: 14 << 3, account: 0, curve: 23 << 3 };

function crc16(bytes: Uint8Array): number {
	let crc = 0;
	for (const byte of bytes) {
		crc ^= byte << 8;
		for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
	}
	return crc;
}

function base32(bytes: Uint8Array): string {
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(buffer >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
	return out;
}

function withCrc(body: Uint8Array): Uint8Array {
	const crc = crc16(body);
	const full = new Uint8Array(body.length + 2);
	full.set(body);
	full[body.length] = crc & 0xff;
	full[body.length + 1] = crc >> 8;
	return full;
}

function encodeSeed(role: number, raw: Uint8Array): string {
	const body = new Uint8Array(2 + raw.length);
	body[0] = ROLE.seed | (role >> 5);
	body[1] = (role & 31) << 3;
	body.set(raw, 2);
	return base32(withCrc(body));
}

type Nkey = Readonly<{ publicKey: string; sign(bytes: Uint8Array): Buffer }>;

function nkey(role: number, raw: Uint8Array): Nkey {
	const privateKey = createPrivateKey({
		key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(raw)]),
		format: "der",
		type: "pkcs8",
	});
	const x = createPublicKey(privateKey).export({ format: "jwk" }).x ?? "";
	const body = new Uint8Array(33);
	body[0] = role;
	body.set(Buffer.from(x, "base64url"), 1);
	return { publicKey: base32(withCrc(body)), sign: (bytes) => sign(null, bytes, privateKey) };
}

/** As `@hobo/fleet-nats` derives a key from the operator signing seed. */
function derived(seed: string, scope: string, purpose: string): Uint8Array {
	return new Uint8Array(hkdfSync("sha256", encoder.encode(seed), encoder.encode(`hobo-fleet/nats/${scope}`), encoder.encode(purpose), 32));
}

/** domain-view: the JSON a NATS JWT claim holds. */
type JsonClaim = string | number | boolean | readonly JsonClaim[] | Readonly<{ [key: string]: JsonClaim }>;

function jwt(issuer: Nkey, claims: Readonly<Record<string, JsonClaim>>): string {
	const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ed25519-nkey" })).toString("base64url");
	const body = { ...claims, iat: Math.floor(Date.now() / 1000) };
	const jti = base32(createHash("sha256").update(JSON.stringify(body)).digest());
	const payload = Buffer.from(JSON.stringify({ jti, ...body, iss: issuer.publicKey })).toString("base64url");
	const signature = issuer.sign(encoder.encode(`${header}.${payload}`)).toString("base64url");
	return `${header}.${payload}.${signature}`;
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

function certificates(dir: string) {
	writeFileSync(join(dir, "san.cnf"), "subjectAltName=IP:127.0.0.1,DNS:localhost\n");
	const key = ["-newkey", "ed25519", "-nodes"];
	openssl(["req", "-x509", ...key, "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", "/CN=hobo-l26-test-ca"], dir);
	openssl(["req", ...key, "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost"], dir);
	openssl(
		["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem", "-days", "1", "-extfile", "san.cnf"],
		dir,
	);
	return { ca: join(dir, "ca.pem"), cert: join(dir, "server.pem"), key: join(dir, "server.key") };
}

/** A bus provider that starts its own `nats-server` and stops it on `close`. */
export const natsBusProvider: BusProvider = async ({ trust, envelope, now }) => {
	if (NATS_BINARY === "")
		throw new Error("nats-server is not available: set HOBO_FLEET_NATS_SERVER_BIN or put nats-server on PATH");
	const dir = mkdtempSync(join(tmpdir(), "hobo-l26-nats-"));
	const tls = certificates(dir);
	const previousCa = process.env.HOBO_FLEET_NATS_CA;
	process.env.HOBO_FLEET_NATS_CA = tls.ca;
	const operator = nkey(ROLE.operator, randomBytes(32));
	const signingRaw = randomBytes(32);
	const operatorSigningSeed = encodeSeed(ROLE.operator, signingRaw);
	const signing = nkey(ROLE.operator, signingRaw);
	const system = nkey(ROLE.account, derived(operatorSigningSeed, "$SYS", "account"));
	const operatorJwt = jwt(operator, {
		name: "hobo-l26-test",
		sub: operator.publicKey,
		nats: { signing_keys: [signing.publicKey], system_account: system.publicKey, type: "operator", version: 2 },
	});
	const systemJwt = jwt(signing, {
		name: "SYS",
		sub: system.publicKey,
		nats: {
			limits: { subs: -1, data: -1, payload: -1, imports: -1, exports: -1, wildcards: true, conn: -1, leaf: -1 },
			type: "account",
			version: 2,
		},
	});
	const port = await freePort();
	writeFileSync(
		join(dir, "server.conf"),
		[
			`listen: "127.0.0.1:${port}"`,
			`tls { cert_file: "${tls.cert}", key_file: "${tls.key}" }`,
			`operator: "${operatorJwt}"`,
			`system_account: "${system.publicKey}"`,
			`resolver: { type: full, dir: "${join(dir, "jwt")}", allow_delete: false, interval: "2m" }`,
			`resolver_preload: { "${system.publicKey}": "${systemJwt}" }`,
			`jetstream { store_dir: "${join(dir, "js")}" }`,
		].join("\n"),
	);
	const server: ChildProcess = spawn(NATS_BINARY, ["-c", join(dir, "server.conf")], { stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`nats-server did not start: ${stderr}`)), 15_000);
		server.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (stderr.includes("Server is ready")) {
				clearTimeout(timer);
				resolve();
			}
		});
		server.once("exit", () => {
			clearTimeout(timer);
			reject(new Error(`nats-server exited: ${stderr}`));
		});
	});
	const stopServer = async () => {
		if (server.exitCode === null) {
			const exited = new Promise((resolve) => server.once("exit", resolve));
			server.kill("SIGTERM");
			await exited;
		}
		rmSync(dir, { recursive: true, force: true });
		if (previousCa === undefined) delete process.env.HOBO_FLEET_NATS_CA;
		else process.env.HOBO_FLEET_NATS_CA = previousCa;
	};
	try {
		const url = `tls://127.0.0.1:${port}`;
		const provisioned = await provisionTopology({ servers: [url], operatorSigningSeed, tenant: parseTenantId(trust.tenant), replicas: 1 });
		const log = () => undefined;
		const authority = await connectAuthorityBus({
			servers: [url],
			credentials: provisioned.staticCredentials.authority,
			trust: () => trust,
			log,
		});
		await authority.publisher.putTrust(envelope);
		const responder = await startCalloutResponder({
			servers: [url],
			credentials: provisioned.staticCredentials.authority,
			xkeySeed: encodeSeed(ROLE.curve, derived(operatorSigningSeed, trust.tenant, "callout-xkey")),
			scopedSeeds: provisioned.scopedSeeds,
			registry: authority.registry,
			replay: authority.replay,
			incarnation: trust.authorityIncarnation,
			now,
			log,
		});
		return {
			bus: authority,
			connector: createNatsBusConnector(),
			natsUrls: [url],
			natsSentinelCredentials: provisioned.staticCredentials.sentinel,
			async close() {
				await responder.stop();
				await authority.close();
				await stopServer();
			},
		};
	} catch (error) {
		await stopServer();
		throw error;
	}
};
