/**
 * The production pieces of `hobo fleet`: settings from the environment, the
 * person and enrollment files, the device credentials protocol, key rotation
 * bundles, `ops provision`'s slots, and the runtime's own I/O (no network
 * beyond loopback; no authority).
 */
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary, toJsonString } from "@bufbuild/protobuf";
import {
	CredentialResponseSchema,
	DiscoverySchema,
	EnrollmentResponseSchema,
	type FleetClient,
	KeyBundleSchema,
	MemberRecordSchema,
	PersonCredentialSchema,
	SandboxTier,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	TrustRecordSchema,
	WitnessedEnvelopeSchema,
} from "@hobo/fleet";
import {
	createMemoryKeyStore,
	parsePublicJwk,
	verifyEnvelope,
} from "@hobo/fleet/keys";
import { createMemorySecretsPort } from "@hobo/identity";
import { afterEach, describe, expect, it } from "vitest";
import {
	deleteEnrollment,
	deletePerson,
	fleetHome,
	newSignInKey,
	readEnrollment,
	readPerson,
	saveEnrollment,
	savePerson,
} from "../src/fleet-home.js";
import {
	decodeSeed,
	encodePublic,
	encodeSeed,
	freshCurveSeed,
	publicOfSeed,
} from "../src/fleet-nkeys.js";
import {
	activeSeed,
	createFleetRuntime,
	deviceCredentials,
	journalEvents,
	keyStoreFor,
	provisionWith,
	rotationBundle,
	sandboxCap,
	serviceDefinitionPath,
	transportOrder,
} from "../src/fleet-runtime.js";
import { isJsonString } from "../src/json.js";
import { recordingClient } from "./support/fleet-fakes.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function temporary(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "hobo-fleet-runtime-"));
	directories.push(path);
	return path;
}

const quiet = () => undefined;

describe("settings from the environment", () => {
	it("chooses the key store", () => {
		expect(keyStoreFor({ HOBO_FLEET_HOME: "/tmp/x" }).ok).toBe(true);
		expect(
			keyStoreFor({
				HOBO_FLEET_KEYSTORE: "external-signer:/usr/bin/signer --x",
			}).ok,
		).toBe(true);
		expect(keyStoreFor({ HOBO_FLEET_KEYSTORE: "external-signer:" }).ok).toBe(
			false,
		);
		expect(keyStoreFor({ HOBO_FLEET_KEYSTORE: "vault" }).ok).toBe(false);
	});

	it("caps the sandbox tier and orders the transports", () => {
		expect(sandboxCap({ HOBO_FLEET_SANDBOX: "s2" })).toBe(
			SandboxTier.S2_USER_KERNEL,
		);
		expect(sandboxCap({ HOBO_FLEET_SANDBOX: "S1" })).toBe(
			SandboxTier.S1_CONTAINER,
		);
		expect(sandboxCap({ HOBO_FLEET_SANDBOX: "S3" })).toBe(
			SandboxTier.S3_MICROVM,
		);
		expect(sandboxCap({})).toBeUndefined();
		expect(transportOrder({})).toEqual(["p2p", "overlay", "bus-relay"]);
		expect(
			transportOrder({
				HOBO_FLEET_TRANSPORTS: "bus-relay, carrier-pigeon,p2p",
			}),
		).toEqual(["bus-relay", "p2p"]);
	});

	it("names the home and the service definition paths", () => {
		expect(fleetHome({ HOBO_FLEET_HOME: "/x" })).toBe("/x");
		expect(fleetHome({})).toMatch(/\.hobo[\\/]fleet$/);
		expect(serviceDefinitionPath("linux", { HOME: "/h" })).toBe(
			"/h/.config/systemd/user/hobo-fleet.service",
		);
		expect(serviceDefinitionPath("darwin", { HOME: "/h" })).toBe(
			"/h/Library/LaunchAgents/dev.hobo.fleet.plist",
		);
		expect(serviceDefinitionPath("win32", { HOME: "/h" })).toContain(
			"hobo-fleet.xml",
		);
		expect(serviceDefinitionPath("aix", { HOME: "/h" })).toBeUndefined();
	});
});

describe("the person and enrollment files", () => {
	it("round-trips the person token with its key, privately, and forgets it on logout", async () => {
		const home = await temporary();
		expect(await readPerson(home)).toBeUndefined();
		const key = newSignInKey();
		await savePerson(
			home,
			create(PersonCredentialSchema, {
				token: "tok",
				expiresAt: "2999-01-01T00:00:00.000Z",
				principal: "user:ada",
				tenant: "acme",
			}),
			key,
		);
		expect((await stat(join(home, "person.json"))).mode & 0o077).toBe(0);
		const person = await readPerson(home);
		expect(person?.token).toBe("tok");
		expect(person?.key.thumbprint).toBe(key.thumbprint);
		// The stored key signs as the one that was saved.
		const signature = await person?.key.signer.sign(new Uint8Array([1]));
		expect(signature?.length).toBe(64);
		await deletePerson(home);
		expect(await readPerson(home)).toBeUndefined();
	});

	it("refuses to save a key it did not make, and reads a damaged file as none", async () => {
		const home = await temporary();
		const key = newSignInKey();
		await expect(
			savePerson(home, create(PersonCredentialSchema, {}), { ...key }),
		).rejects.toThrow("only a sign-in key");
		await writeFile(join(home, "person.json"), "{nope");
		expect(await readPerson(home)).toBeUndefined();
		await writeFile(
			join(home, "person.json"),
			'{"token":"t","key":"AAAA","principal":"p","tenant":"t"}',
		);
		expect(await readPerson(home)).toBeUndefined();
	});

	it("round-trips the enrollment and refuses a missing or damaged one", async () => {
		const home = await temporary();
		expect((await readEnrollment(home)).ok).toBe(false);
		await saveEnrollment(home, {
			memberId: "m_1",
			tenant: "acme",
			discovery: create(DiscoverySchema, {
				tenant: "acme",
				relayUrls: ["https://r"],
			}),
		});
		const read = await readEnrollment(home);
		expect(read.ok && read.value.discovery.relayUrls).toEqual(["https://r"]);
		await writeFile(join(home, "enrollment.json"), '{"memberId":1}');
		expect((await readEnrollment(home)).ok).toBe(false);
		await deleteEnrollment(home);
		expect((await readEnrollment(home)).ok).toBe(false);
	});
});

describe("nkeys", () => {
	it("encodes account and curve seeds and their public keys", () => {
		const seed = new Uint8Array(32).fill(7);
		const account = encodeSeed("account", seed);
		expect(account.startsWith("SA")).toBe(true);
		expect(publicOfSeed(account)).toBe(encodePublic("account", seed));
		expect(encodePublic("account", seed).startsWith("A")).toBe(true);
		const curve = freshCurveSeed();
		expect(curve.startsWith("SX")).toBe(true);
		expect(publicOfSeed(curve)?.startsWith("X")).toBe(true);
		expect(decodeSeed(account)?.seed).toEqual(seed);
		expect(decodeSeed(`${account.slice(0, -1)}A`)).toBeUndefined();
		expect(decodeSeed("not base32!")).toBeUndefined();
		expect(publicOfSeed("SA")).toBeUndefined();
	});
});

describe("ops provision", () => {
	const config = JSON.stringify({
		tenant: "acme",
		natsUrls: ["nats://n:4222"],
	});

	it("stores the static users, the scoped slots and a callout xkey", async () => {
		const secrets = createMemorySecretsPort();
		const operator = encodeSeed("account", new Uint8Array(32).fill(1));
		await secrets.put(
			"hobo-fleet/acme/operator-signing",
			JSON.stringify({
				v: 1,
				active: "operator-signing#1",
				keys: [{ kid: "operator-signing#1", seed: operator, publicKey: "O" }],
			}),
		);
		const scoped = encodeSeed("account", new Uint8Array(32).fill(2));
		const seen: string[] = [];
		const result = await provisionWith({
			configText: config,
			secrets,
			replicas: 3,
			provision: async (input) => {
				seen.push(
					`${input.tenant}:${input.replicas}:${input.operatorSigningSeed === operator}`,
				);
				return {
					accountPublicKey: "AACC",
					staticCredentials: {
						authority: "a",
						witness: "w",
						provisioner: "p",
						sentinel: "s",
					},
					scopedSeeds: {
						observer: scoped,
						executor: scoped,
						dispatcher: scoped,
					},
				};
			},
		});
		expect(result.ok).toBe(true);
		expect(seen).toEqual(["acme:3:true"]);
		const read = async (name: string) => {
			const value = await secrets.access(name);
			return value.status === "ok" ? value.material : undefined;
		};
		expect(await read("hobo-fleet/acme/nats-authority")).toBe("a");
		expect(await read("hobo-fleet/acme/nats-sentinel")).toBe("s");
		const slot = JSON.parse(
			(await read("hobo-fleet/acme/scoped-executor")) ?? "{}",
		);
		expect(slot).toEqual({
			v: 1,
			active: "scoped-executor#1",
			keys: [
				{
					kid: "scoped-executor#1",
					seed: scoped,
					publicKey: publicOfSeed(scoped),
				},
			],
		});
		expect((await read("hobo-fleet/acme/callout-xkey"))?.startsWith("SX")).toBe(
			true,
		);
		expect(result.ok && result.value).toContain("Callout xkey");
	});

	it("refuses without the ceremony's key, a tenant or servers, and reports a failed provision", async () => {
		const secrets = createMemorySecretsPort();
		const fail = async () => {
			throw new Error("nats down");
		};
		const noKey = await provisionWith({
			configText: config,
			secrets,
			replicas: 1,
			provision: fail,
		});
		expect(!noKey.ok && noKey.error.message).toContain("ops ceremony");
		expect(
			(
				await provisionWith({
					configText: "{}",
					secrets,
					replicas: 1,
					provision: fail,
				})
			).ok,
		).toBe(false);
		expect(
			(
				await provisionWith({
					configText: "[",
					secrets,
					replicas: 1,
					provision: fail,
				})
			).ok,
		).toBe(false);
		expect(
			(
				await provisionWith({
					configText: '{"tenant":"acme"}',
					secrets,
					replicas: 1,
					provision: fail,
				})
			).ok,
		).toBe(false);
		await secrets.put(
			"hobo-fleet/acme/operator-signing",
			JSON.stringify({
				v: 1,
				active: "k",
				keys: [{ kid: "k", seed: "S", publicKey: "O" }],
			}),
		);
		const failed = await provisionWith({
			configText: config,
			secrets,
			replicas: 1,
			provision: fail,
		});
		expect(!failed.ok && failed.error.message).toContain("nats down");
	});

	it("reads the active seed of a slot", () => {
		expect(
			activeSeed(
				'{"v":1,"active":"b","keys":[{"kid":"a","seed":"x"},{"kid":"b","seed":"y"}]}',
			),
		).toBe("y");
		expect(activeSeed('{"v":1,"active":"c","keys":[]}')).toBeUndefined();
		expect(activeSeed("nope")).toBeUndefined();
	});
});

describe("the device credentials protocol", () => {
	it("writes the nonce before asking and the new generation after", async () => {
		const store = createMemoryKeyStore();
		const calls: string[] = [];
		const base = recordingClient(calls, { pollPending: 0, failures: {} });
		const client: FleetClient = {
			...base,
			credentials: async (request) => {
				const state = await store.readState();
				expect(state.pendingRefreshNonce).toEqual(request.request.refreshNonce);
				return {
					ok: true,
					value: create(CredentialResponseSchema, {
						svid: "svid-1",
						generation: 5,
					}),
				};
			},
		};
		const answer = await deviceCredentials(store, () => client);
		expect(answer.ok && answer.value.svid).toBe("svid-1");
		const state = await store.readState();
		expect(state.generation).toBe(5);
		expect(state.pendingRefreshNonce).toBeUndefined();
	});

	it("keeps the nonce when the authority refuses, so a retry reuses it", async () => {
		const store = createMemoryKeyStore();
		const calls: string[] = [];
		const client = recordingClient(calls, {
			pollPending: 0,
			failures: { credentials: { code: "unavailable", message: "down" } },
		});
		expect((await deviceCredentials(store, () => client)).ok).toBe(false);
		const first = (await store.readState()).pendingRefreshNonce;
		expect(first).toBeDefined();
		await deviceCredentials(store, () => client);
		expect((await store.readState()).pendingRefreshNonce).toEqual(first);
	});

	it("signs the next key bundle with the identity key", async () => {
		const keys = await createMemoryKeyStore().open();
		const envelope = await rotationBundle(
			keys,
			4,
			Date.parse("2026-11-13T00:00:00Z"),
			3_600_000,
		);
		const jwk = parsePublicJwk(keys.identityJwk);
		expect(
			jwk.ok && verifyEnvelope(envelope, "hobo-fleet/key-bundle/v1", jwk.value),
		).toBe(true);
		const bundle = fromBinary(KeyBundleSchema, envelope.payload);
		expect(bundle.sequence).toBe(4);
		expect(bundle.keys.map((key) => key.keyId)).toEqual([
			`${keys.memberId}#sign`,
			`${keys.memberId}#seal`,
		]);
		expect(bundle.notAfter).toBe("2026-11-13T01:00:00.000Z");
	});
});

describe("audit journal files", () => {
	it("reads an exported journal as event envelopes", () => {
		const events = journalEvents(
			JSON.stringify([
				{
					id: "e1",
					type: "fleet.TrustRotated",
					v: 1,
					streamId: "fleet-trust",
					seq: 1,
					ts: "2026-11-13T00:00:00.000Z",
					actor: { kind: "service", id: "authority" },
					tenant: "acme",
					data: { record: "", sequence: 2 },
				},
			]),
		);
		expect(events[0]?.type).toBe("fleet.TrustRotated");
		expect(() => journalEvents("{}")).toThrow("not a JSON array");
	});
});

describe("the runtime", () => {
	it("refuses clients without an authority URL or a sign-in", async () => {
		const home = await temporary();
		const none = createFleetRuntime({
			env: { HOBO_FLEET_HOME: home },
			progress: quiet,
		});
		const refused = await none.client({ kind: "none" });
		expect(!refused.ok && refused.error.message).toContain(
			"HOBO_FLEET_AUTHORITY_URL",
		);
		const runtime = createFleetRuntime({
			env: {
				HOBO_FLEET_HOME: home,
				HOBO_FLEET_AUTHORITY_URL: "https://fleet.test",
			},
			progress: quiet,
		});
		expect((await runtime.client({ kind: "none" })).ok).toBe(true);
		const key = newSignInKey();
		expect(
			(
				await runtime.client({
					kind: "sign-in",
					signer: key.signer,
					publicJwk: key.publicJwk,
				})
			).ok,
		).toBe(true);
		const person = await runtime.client({ kind: "person" });
		expect(!person.ok && person.error.code).toBe("unauthenticated");
		await savePerson(
			home,
			create(PersonCredentialSchema, {
				token: "t",
				principal: "p",
				tenant: "acme",
			}),
			key,
		);
		expect((await runtime.client({ kind: "person" })).ok).toBe(true);
	});

	it("asks for device credentials through the SIGN key before a device call", async () => {
		const home = await temporary();
		const requests: string[] = [];
		const runtime = createFleetRuntime({
			env: {
				HOBO_FLEET_HOME: home,
				HOBO_FLEET_AUTHORITY_URL: "https://fleet.test",
			},
			progress: quiet,
			fetch: async (input, init) => {
				requests.push(
					`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`,
				);
				return Response.json(
					{ code: "member-unknown", message: "who" },
					{ status: 404 },
				);
			},
		});
		const device = await runtime.client({ kind: "device" });
		expect(device.ok).toBe(false);
		expect(requests[0]).toMatch(/^POST \/v1\/fleet\/members\/.+\/credentials$/);
	});

	it("generates, loads and deletes this device's keys", async () => {
		const home = await temporary();
		const runtime = createFleetRuntime({
			env: { HOBO_FLEET_HOME: home },
			progress: quiet,
		});
		const keys = await runtime.local.generateKeys();
		expect(keys.ok).toBe(true);
		const loaded = await runtime.local.loadKeyStore();
		expect(loaded.ok && keys.ok && loaded.value).toBe(
			`member ${keys.ok ? keys.value.memberId : ""}`,
		);
		const member = await runtime.io.deviceMemberId();
		expect(member.ok && keys.ok && member.value === keys.value.memberId).toBe(
			true,
		);
		await runtime.local.deleteKeys();
		await runtime.local.deletePersonToken();
	});

	it("installs nothing for status and uninstall when no definition exists", async () => {
		const home = await temporary();
		const runtime = createFleetRuntime({
			env: {
				HOBO_FLEET_HOME: home,
				HOME: home,
				XDG_CONFIG_HOME: join(home, "config"),
			},
			progress: quiet,
		});
		if (process.platform !== "linux") return;
		const path =
			serviceDefinitionPath("linux", {
				HOME: home,
				XDG_CONFIG_HOME: join(home, "config"),
			}) ?? "";
		expect(await runtime.local.installService("status")).toEqual({
			ok: true,
			value: "Not installed.",
		});
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, "[Unit]\n");
		expect(await runtime.local.installService("status")).toEqual({
			ok: true,
			value: `Installed at ${path}.`,
		});
		const removed = await runtime.local.installService("uninstall");
		expect(removed.ok && removed.value).toContain("Removed");
		expect(await runtime.local.installService("uninstall")).toEqual({
			ok: true,
			value: "Not installed.",
		});
	});

	it("checks the bus by connecting to the first discovered server", async () => {
		const runtime = createFleetRuntime({
			env: { HOBO_FLEET_HOME: await temporary() },
			progress: quiet,
		});
		const server = createServer((socket) => socket.end());
		await new Promise<void>((done) =>
			server.listen(0, "127.0.0.1", () => done()),
		);
		const address = server.address();
		const port = address !== null && !isJsonString(address) ? address.port : 0;
		const reachable = await runtime.local.busConnect(
			create(DiscoverySchema, { natsUrls: [`nats://127.0.0.1:${port}`] }),
		);
		expect(reachable.ok).toBe(true);
		server.close();
		expect(
			(await runtime.local.busConnect(create(DiscoverySchema, {}))).ok,
		).toBe(false);
		expect(
			(
				await runtime.local.busConnect(
					create(DiscoverySchema, { natsUrls: ["::"] }),
				)
			).ok,
		).toBe(false);
	});

	it("verifies the audit chain only against a trust record it has", async () => {
		const home = await temporary();
		const runtime = createFleetRuntime({
			env: { HOBO_FLEET_HOME: home },
			progress: quiet,
		});
		const missing = await runtime.local.verifyAuditChain([], [], {});
		expect(!missing.ok && missing.error.message).toContain("--trust");
		const trustFile = join(home, "trust.json");
		const record = create(TrustRecordSchema, { tenant: "acme", sequence: 1 });
		await writeFile(
			trustFile,
			toJsonString(
				WitnessedEnvelopeSchema,
				create(WitnessedEnvelopeSchema, {
					authority: create(SignedEnvelopeSchema, {
						payload: toBinary(TrustRecordSchema, record),
					}),
				}),
			),
		);
		const empty = await runtime.local.verifyAuditChain([], [], { trustFile });
		expect(empty).toEqual({ ok: true, value: { entries: 0, finalThrough: 0 } });
	});

	it("reads secrets from files, writes text, and saves an enrollment", async () => {
		const home = await temporary();
		const runtime = createFleetRuntime({
			env: { HOBO_FLEET_HOME: home, HOBO_FLEET_TENANT: "acme" },
			progress: quiet,
		});
		await writeFile(join(home, "token"), "hft_secret\n");
		expect(await runtime.io.readSecret(join(home, "token"))).toBe("hft_secret");
		await runtime.io.writeText(join(home, "out.txt"), "hello");
		expect(await runtime.io.readText(join(home, "out.txt"))).toBe("hello");
		expect(runtime.io.tenant()).toBe("acme");
		const member: SignedEnvelope = create(SignedEnvelopeSchema, {
			payload: toBinary(
				MemberRecordSchema,
				create(MemberRecordSchema, {
					memberId: "m_1",
					tenant: "acme",
					displayName: "box",
				}),
			),
		});
		const saved = await runtime.io.saveEnrollment(
			create(EnrollmentResponseSchema, {
				memberRecord: member,
				discovery: create(DiscoverySchema, { tenant: "acme" }),
			}),
		);
		expect(saved.ok).toBe(true);
		expect(
			JSON.parse(await readFile(join(home, "enrollment.json"), "utf8"))
				.memberId,
		).toBe("m_1");
		expect(
			(await runtime.io.saveEnrollment(create(EnrollmentResponseSchema, {})))
				.ok,
		).toBe(false);
	});

	it("receives the sign-in redirect on its loopback address", async () => {
		const runtime = createFleetRuntime({
			env: { HOBO_FLEET_HOME: await temporary() },
			progress: quiet,
		});
		const loopback = await runtime.io.loopback();
		expect(loopback.redirectUri).toMatch(
			/^http:\/\/127\.0\.0\.1:\d+\/callback$/,
		);
		const answer = await fetch(`${loopback.redirectUri}?state=s1&code=c1`);
		expect(answer.status).toBe(200);
		expect(await loopback.result).toEqual({ state: "s1", code: "c1" });
		loopback.close();
	});

	it("refuses the operations without a secret store adapter", async () => {
		const runtime = createFleetRuntime({
			env: { HOBO_FLEET_HOME: await temporary() },
			progress: quiet,
		});
		for (const result of [
			await runtime.local.runCeremony("fleet.json"),
			await runtime.local.rotateKey("fleet.json", "witness"),
			await runtime.local.backup("fleet.json", "a"),
			await runtime.local.restore("fleet.json", "a"),
			await runtime.local.provisionTopology({
				configPath: "fleet.json",
				replicas: 1,
			}),
		])
			expect(!result.ok && result.error.code).toBe("unavailable");
	});

	it("runs the operations with the secret store it is given", async () => {
		const home = await temporary();
		const configPath = join(home, "fleet.json");
		await writeFile(
			configPath,
			JSON.stringify({ tenant: "acme", dataDir: join(home, "data") }),
		);
		const secrets = createMemorySecretsPort();
		const runtime = createFleetRuntime({
			env: { HOBO_FLEET_HOME: home },
			progress: quiet,
			openSecrets: async () => ({ ok: true, value: secrets }),
			log: quiet,
		});
		const ceremony = await runtime.local.runCeremony(configPath);
		expect(ceremony.ok && ceremony.value.shares).toHaveLength(2);
		const provision = await runtime.local.provisionTopology({
			configPath,
			replicas: 1,
		});
		expect(!provision.ok && provision.error.message).toContain("natsUrls");
	});
});
