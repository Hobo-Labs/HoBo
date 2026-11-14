/**
 * The device agent against `createTestAuthority` (design §6.5, §9 F4, F7,
 * F19; O35): enrollment pins the trust record and returns the whole
 * response; a lost refresh answer does not lock, while a copied key does; a
 * changed trust record is pinned only through `acceptTrust`; through a bus
 * outage every receipt waits in `AgentState.pendingReceipts` and is
 * published once afterwards; the agent reconnects after its connection
 * closes, observes itself and its sponsored members, restarts its executor
 * when its memberships change, and follows control messages.
 */
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import {
	create,
	fromBinary,
	fromJsonString,
	toBinary,
	toJsonString,
} from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	agentIn,
	createWorld,
	FLEET,
	heldRunner,
	queueSource,
	TENANT,
	type World,
} from "../../examples/world.js";
import {
	ControlKind,
	CredentialResponseSchema,
	DeviceClass,
	EnrollmentRequestSchema,
	EnrollmentResponseSchema,
	Health,
	KeyAlgorithm,
	KeyBundleSchema,
	KeyPurpose,
	LifecycleRequestSchema,
	MemberControlSchema,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	MembershipRequestSchema,
	type Observation,
	ObservationSchema,
	PublicKeyRefSchema,
	ReceiptStatus,
	Role,
	SandboxTier,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	TrustRecordSchema,
	type WitnessedEnvelope,
	WitnessedEnvelopeSchema,
	type WorkReceipt,
	WorkReceiptSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	CONTROL_CONTEXT,
	MEMBER_RECORD_CONTEXT,
	TRUST_RECORD_CONTEXT,
} from "../../src/contexts.js";
import {
	type FleetId,
	parseFleetId,
	parseKeyId,
	parseMemberId,
} from "../../src/ids.js";
import { signEnvelope } from "../../src/keys/index.js";
import type {
	AgentState,
	FleetLog,
	FleetLogEvent,
	KeyStore,
	Signer,
} from "../../src/ports.js";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const now = () => Date.now();

beforeEach(() => {
	vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
	vi.useRealTimers();
});

type Line = Readonly<{
	event: FleetLogEvent;
	fields: Readonly<Record<string, string | number | boolean>>;
}>;

function logs() {
	const lines: Line[] = [];
	const log: FleetLog = (event, fields) => {
		lines.push({ event, fields });
	};
	return { lines, log };
}

function enrollment(
	token: string,
	name: string,
	roles: readonly Role[],
	fleet: FleetId = FLEET,
) {
	return create(EnrollmentRequestSchema, {
		tenant: TENANT,
		fleet,
		name,
		displayName: name,
		platform: { os: "linux", arch: "x64" },
		region: "eu-west",
		deviceClass: DeviceClass.DEDICATED,
		requestedRoles: [...roles],
		proof: { case: "bootstrapToken", value: token },
	});
}

async function enrolled(
	world: World,
	name: string,
	roles: readonly Role[],
	options: Parameters<typeof agentIn>[1] = { now },
	fleet: FleetId = FLEET,
) {
	const built = agentIn(world, options);
	const outcome = await built.agent.enroll(
		enrollment(await world.token(name, roles, fleet), name, roles, fleet),
	);
	if (!outcome.ok) throw new Error(`enroll: ${outcome.error.message}`);
	return { ...built, response: outcome.value };
}

const memberOf = async (world: World, keys: KeyStore) =>
	world.bus.registry.member((await keys.open()).memberId);

function receiptsOn(world: World): WorkReceipt[] {
	const seen: WorkReceipt[] = [];
	world.bus.events.subscribe(["receipt"], "start", async (event) => {
		seen.push(fromBinary(WorkReceiptSchema, event.payload));
	});
	return seen;
}

/** An Ed25519 key in memory, as a signer and as a trust record's key reference. */
function testKey(keyId: string, purpose: KeyPurpose) {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const signer: Signer = {
		keyId: parseKeyId(keyId),
		algorithm: KeyAlgorithm.EDDSA,
		sign: async (bytes) => new Uint8Array(signBytes(null, bytes, privateKey)),
	};
	const ref = create(PublicKeyRefSchema, {
		purpose,
		keyId,
		algorithm: KeyAlgorithm.EDDSA,
		value: publicKey
			.export({ format: "der", type: "spki" })
			.subarray(-32)
			.toString("base64url"),
	});
	return { signer, ref };
}

type TestKey = ReturnType<typeof testKey>;

async function trustRecord(
	sequence: number,
	keys: Readonly<{ authority: TestKey; witness: TestKey }>,
	signers: Readonly<{ authority: TestKey; witness: TestKey }> = keys,
): Promise<WitnessedEnvelope> {
	const payload = toBinary(
		TrustRecordSchema,
		create(TrustRecordSchema, {
			tenant: TENANT,
			sequence,
			authorityKeys: [keys.authority.ref],
			witnessKeys: [keys.witness.ref],
			authorityIncarnation: 1,
			issuer: "https://authority.fleet.test",
			issuedAt: new Date(now()).toISOString(),
		}),
	);
	return create(WitnessedEnvelopeSchema, {
		authority: await signEnvelope(
			signers.authority.signer,
			TRUST_RECORD_CONTEXT,
			payload,
		),
		witness: await signEnvelope(
			signers.witness.signer,
			TRUST_RECORD_CONTEXT,
			payload,
		),
	});
}

/** The same payload, signed again by `key` (a stand-in authority the test controls). */
async function resign(envelope: SignedEnvelope | undefined, key: TestKey) {
	if (envelope === undefined) return undefined;
	return signEnvelope(key.signer, MEMBER_RECORD_CONTEXT, envelope.payload);
}

const pinnedSequence = (state: AgentState) =>
	fromBinary(
		TrustRecordSchema,
		state.trust?.authority?.payload ?? new Uint8Array(),
	).sequence;

describe("enrollment", () => {
	it("enrolls through the client, returns the whole response and pins the trust record", async () => {
		const world = await createWorld(now);
		const { agent, keys, response } = await enrolled(world, "box", [
			Role.EXECUTOR,
		]);
		const self = await keys.open();
		const record = fromBinary(
			MemberRecordSchema,
			response.memberRecord?.payload ?? new Uint8Array(),
		);
		expect(record.memberId).toBe(self.memberId);
		expect(record.state).toBe(MemberState.ACTIVE);
		expect(response.discovery?.tenant).toBe(TENANT);
		expect(world.http.calls).toEqual(["enroll"]);
		const state = await keys.readState();
		expect(state.trust).toEqual(world.trust);
		expect(state.generation).toBe(0);
		expect(agent.status().member?.memberId).toBe(self.memberId);
		expect(agent.status().bus).toBe("stopped");
		expect(agent.bus()).toBeUndefined();
	});

	it("refuses to start before it has enrolled", async () => {
		const world = await createWorld(now);
		const { agent } = agentIn(world, { now });
		await expect(agent.start()).rejects.toThrow(/not enrolled/);
	});

	it("refuses an answer whose member record the answered trust record did not sign", async () => {
		const world = await createWorld(now);
		const stranger = testKey("authority#9", KeyPurpose.AUTHORITY);
		world.http.tap((exchange) => {
			if (exchange.route !== "enroll" || exchange.status !== 200)
				return "deliver";
			const answer = fromJsonString(EnrollmentResponseSchema, exchange.body);
			return {
				body: toJsonString(EnrollmentResponseSchema, {
					...answer,
					memberRecord: {
						...(answer.memberRecord ?? create(SignedEnvelopeSchema)),
						signature: new Uint8Array(64),
						keyId: stranger.signer.keyId,
					},
				}),
			};
		});
		const { agent, keys } = agentIn(world, { now });
		const outcome = await agent.enroll(
			enrollment(await world.token("box", [Role.EXECUTOR]), "box", [
				Role.EXECUTOR,
			]),
		);
		expect(outcome.ok ? undefined : outcome.error.code).toBe("proof-invalid");
		expect((await keys.readState()).trust).toBeUndefined();
	});
});

/** A second key store holding the same keys with its own state: a copied device (F7). */
function copyOf(original: KeyStore, state: AgentState): KeyStore {
	let held = state;
	return {
		open: () => original.open(),
		readState: async () => held,
		writeState: async (next) => {
			held = next;
		},
		rotateOperational: () => original.rotateOperational(),
		destroy: async () => {},
	};
}

const credentialCalls = (world: World) =>
	world.http.calls.filter((call) => call === "credentials").length;

describe("credentials", () => {
	it("connects with the session ticket of its first refresh", async () => {
		const world = await createWorld(now);
		const { agent, keys } = await enrolled(world, "box", [Role.EXECUTOR]);
		await agent.start();
		expect(world.http.calls).toEqual(["enroll", "credentials", "discovery"]);
		expect(world.connector.connects()).toBe(1);
		expect(world.connector.tickets()).toHaveLength(1);
		expect((await keys.readState()).generation).toBe(1);
		expect(agent.status().bus).toBe("connected");
		expect(agent.bus()).toBeDefined();
		expect(agent.status().tiers).toEqual([
			SandboxTier.S1_CONTAINER,
			SandboxTier.S2_USER_KERNEL,
			SandboxTier.S3_MICROVM,
		]);
		await agent.stop();
		expect(agent.bus()).toBeUndefined();
	});

	it("refreshes five minutes before the SVID expires, and keeps refreshing", async () => {
		const world = await createWorld(now);
		const { agent, keys } = await enrolled(world, "box", [Role.EXECUTOR]);
		await agent.start();
		await vi.advanceTimersByTimeAsync(9 * 60_000);
		expect((await keys.readState()).generation).toBe(1);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect((await keys.readState()).generation).toBe(2);
		await world.authority.tick();
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect((await keys.readState()).generation).toBe(3);
		expect((await memberOf(world, keys))?.state).toBe(MemberState.ACTIVE);
		await agent.stop();
	});

	it("survives a lost refresh answer: the same generation and nonce get the same answer, even across a restart (F19)", async () => {
		const world = await createWorld(now);
		const { agent, keys } = await enrolled(world, "box", [Role.EXECUTOR]);
		let drops = 2; // the refresh at start and the one the bus connect asks for
		world.http.tap((exchange) => {
			if (exchange.route !== "credentials" || drops === 0) return "deliver";
			drops -= 1;
			return "drop";
		});
		await agent.start();
		const lost = await keys.readState();
		expect(lost.generation).toBe(0);
		expect(lost.pendingRefreshNonce).toHaveLength(16);
		// The authority answered and advanced; the device never heard it. Stopping now must not lock it.
		await agent.stop();
		const again = agentIn(world, { now, keys });
		await again.agent.start();
		const answered = await keys.readState();
		expect(answered.generation).toBe(1);
		expect(answered.pendingRefreshNonce).toBeUndefined();
		await vi.advanceTimersByTimeAsync(11 * 60_000);
		expect((await keys.readState()).generation).toBe(2);
		expect((await memberOf(world, keys))?.state).toBe(MemberState.ACTIVE);
		await again.agent.stop();
	});

	it("retries a lost answer on its own, with the nonce it wrote before sending", async () => {
		const world = await createWorld(now);
		const { agent, keys } = await enrolled(world, "box", [Role.EXECUTOR]);
		let drops = 2;
		world.http.tap((exchange) => {
			if (exchange.route !== "credentials" || drops === 0) return "deliver";
			drops -= 1;
			return "drop";
		});
		await agent.start();
		expect(agent.status().bus).toBe("disconnected");
		await vi.advanceTimersByTimeAsync(10_000);
		expect((await keys.readState()).generation).toBe(1);
		expect(credentialCalls(world)).toBe(3);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(agent.status().bus).toBe("connected");
		expect((await memberOf(world, keys))?.state).toBe(MemberState.ACTIVE);
		await agent.stop();
	});

	it("a copied key locks the device once both copies have refreshed (F7)", async () => {
		const world = await createWorld(now);
		const { agent, keys } = await enrolled(world, "box", [Role.EXECUTOR]);
		const copied = await keys.readState();
		await agent.start();
		const lines = logs();
		const clone = agentIn(world, {
			now,
			keys: copyOf(keys, copied),
			log: lines.log,
		});
		await clone.agent.start();
		expect((await memberOf(world, keys))?.state).toBe(MemberState.LOCKED);
		expect(lines.lines.map((line) => line.event)).toContain(
			"hobo_fleet_member_locked",
		);
		await agent.stop();
		await clone.agent.stop();
	});
});

/** An HTTP stand-in whose answers pass through `rewrite` (async: signing takes a promise). */
function rewritingFetch(
	world: World,
	rewrite: (route: string, body: string) => Promise<string>,
): typeof fetch {
	let route = "";
	world.http.tap((exchange) => {
		route = exchange.route;
		return "deliver";
	});
	return async (input, init) => {
		const response = await world.http.fetch(input, init);
		const body = await response.text();
		const status = response.status;
		const next = status === 200 ? await rewrite(route, body) : body;
		return new Response(next, { status, headers: response.headers });
	};
}

describe("trust", () => {
	it("keeps its pin when an answer carries a newer trust record the pin does not sign", async () => {
		const world = await createWorld(now);
		const forger = {
			authority: testKey("authority#2", KeyPurpose.AUTHORITY),
			witness: testKey("witness#2", KeyPurpose.WITNESS),
		};
		const forged = await trustRecord(2, forger);
		const lines = logs();
		const fetchThrough = rewritingFetch(world, async (route, body) => {
			if (route !== "credentials") return body;
			const answer = fromJsonString(CredentialResponseSchema, body);
			answer.trust = forged;
			return toJsonString(CredentialResponseSchema, answer);
		});
		const { agent, keys } = await enrolled(world, "box", [Role.EXECUTOR], {
			now,
			log: lines.log,
			fetch: fetchThrough,
		});
		await agent.start();
		const state = await keys.readState();
		expect(pinnedSequence(state)).toBe(1);
		expect(state.trust).toEqual(world.trust);
		expect(state.generation).toBe(1);
		expect(
			lines.lines.find((line) => line.event === "hobo_fleet_trust_rotated")
				?.fields,
		).toMatchObject({ accepted: false, sequence: 2 });
		await agent.stop();
	});

	it("pins a newer trust record that the pinned authority and witness keys both signed, and only that way", async () => {
		const world = await createWorld(now);
		const first = {
			authority: testKey("authority#1", KeyPurpose.AUTHORITY),
			witness: testKey("witness#1", KeyPurpose.WITNESS),
		};
		const second = {
			authority: testKey("authority#2", KeyPurpose.AUTHORITY),
			witness: testKey("witness#2", KeyPurpose.WITNESS),
		};
		const pinned = await trustRecord(1, first);
		const rotated = await trustRecord(2, second, first);
		// Signed by the retired keys after the rotation: not acceptable under the new pin.
		const stale = await trustRecord(3, first);
		let offered: WitnessedEnvelope = rotated;
		const fetchThrough = rewritingFetch(world, async (route, body) => {
			if (route === "enroll") {
				const answer = fromJsonString(EnrollmentResponseSchema, body);
				if (answer.discovery !== undefined) answer.discovery.trust = pinned;
				answer.memberRecord = await resign(
					answer.memberRecord,
					first.authority,
				);
				return toJsonString(EnrollmentResponseSchema, answer);
			}
			if (route === "credentials") {
				const answer = fromJsonString(CredentialResponseSchema, body);
				answer.trust = offered;
				answer.memberRecord = await resign(
					answer.memberRecord,
					second.authority,
				);
				return toJsonString(CredentialResponseSchema, answer);
			}
			return body;
		});
		const lines = logs();
		const { agent, keys } = await enrolled(world, "box", [Role.EXECUTOR], {
			now,
			log: lines.log,
			fetch: fetchThrough,
		});
		expect((await keys.readState()).trust).toEqual(pinned);
		await agent.start();
		expect((await keys.readState()).trust).toEqual(rotated);
		expect(agent.status().member?.recordSequence).toBeGreaterThan(0);

		offered = stale;
		await vi.advanceTimersByTimeAsync(11 * 60_000);
		const state = await keys.readState();
		expect(state.generation).toBe(2);
		expect(state.trust).toEqual(rotated);
		expect(
			lines.lines
				.filter((line) => line.event === "hobo_fleet_trust_rotated")
				.map((line) => line.fields.accepted),
		).toEqual([true, false]);
		await agent.stop();
	});
});

/** Advances fake time a second at a time until `done` holds, or fails after `limitMs`. */
async function until(done: () => boolean, limitMs = 180_000): Promise<void> {
	for (let waited = 0; !done(); waited += 1_000) {
		if (waited >= limitMs) throw new Error("timed out waiting");
		await vi.advanceTimersByTimeAsync(1_000);
	}
}

const succeeded = (receipts: readonly WorkReceipt[]) =>
	receipts.filter((receipt) => receipt.status === ReceiptStatus.SUCCEEDED);

/** A dispatcher agent and an executor agent of fleet `hobo`, both started. */
async function workingPair(world: World) {
	const work = queueSource(now);
	const run = heldRunner();
	const dispatcher = await enrolled(world, "dispatch", [Role.DISPATCHER], {
		now,
		sources: [work.source],
	});
	const executor = await enrolled(world, "runner", [Role.EXECUTOR], {
		now,
		runners: [run.runner],
	});
	await dispatcher.agent.start();
	await executor.agent.start();
	return { work, run, dispatcher, executor };
}

describe("work through a bus outage (F4)", () => {
	it("keeps every receipt in pendingReceipts while the bus is down and publishes each once afterwards", async () => {
		const world = await createWorld(now);
		const receipts = receiptsOn(world);
		const { work, run, dispatcher, executor } = await workingPair(world);
		run.hold();
		work.add("job-1");
		await until(() => run.ran.length === 1);
		expect(receipts.map((receipt) => receipt.status)).toEqual([
			ReceiptStatus.STARTED,
		]);

		world.connector.down(true);
		run.release();
		await vi.advanceTimersByTimeAsync(1_000);
		const queued = await executor.keys.readState();
		expect(queued.pendingReceipts).toHaveLength(1);
		expect(succeeded(receipts)).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(succeeded(receipts)).toHaveLength(0);
		expect((await executor.keys.readState()).pendingReceipts).toHaveLength(1);
		expect(executor.agent.status().bus).toBe("disconnected");

		world.connector.down(false);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(succeeded(receipts)).toHaveLength(1);
		expect((await executor.keys.readState()).pendingReceipts).toEqual([]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(succeeded(receipts)).toHaveLength(1);
		expect(succeeded(receipts)[0]?.memberId).toBe(
			(await executor.keys.open()).memberId,
		);
		await dispatcher.agent.stop();
		await executor.agent.stop();
	});

	it("publishes receipts queued before a restart once the bus is back", async () => {
		const world = await createWorld(now);
		const receipts = receiptsOn(world);
		const { work, run, dispatcher, executor } = await workingPair(world);
		run.hold();
		work.add("job-1");
		await until(() => run.ran.length === 1);
		world.connector.down(true);
		run.release();
		await vi.advanceTimersByTimeAsync(1_000);
		await executor.agent.stop();
		expect((await executor.keys.readState()).pendingReceipts).toHaveLength(1);

		const restarted = agentIn(world, {
			now,
			keys: executor.keys,
			runners: [run.runner],
		});
		await restarted.agent.start();
		expect(restarted.agent.status().bus).toBe("disconnected");
		expect(succeeded(receipts)).toHaveLength(0);
		world.connector.down(false);
		await until(() => succeeded(receipts).length > 0, 60_000);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(succeeded(receipts)).toHaveLength(1);
		expect((await executor.keys.readState()).pendingReceipts).toEqual([]);
		await dispatcher.agent.stop();
		await restarted.agent.stop();
	});

	it("reconnects after its connection closes and keeps taking work", async () => {
		const world = await createWorld(now);
		const receipts = receiptsOn(world);
		const { work, run, dispatcher, executor } = await workingPair(world);
		work.add("job-1");
		await until(() => succeeded(receipts).length === 1);
		await world.connector.closeAll();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(world.connector.connects()).toBe(4);
		expect(executor.agent.status().bus).toBe("connected");
		work.add("job-2");
		await until(() => succeeded(receipts).length === 2);
		expect(run.ran).toEqual(["job-1", "job-2"]);
		await dispatcher.agent.stop();
		await executor.agent.stop();
	});

	it("restarts its executor when its memberships change", async () => {
		const world = await createWorld(now);
		const trunk = parseFleetId("trunk");
		await world.defineFleet(trunk);
		const receipts = receiptsOn(world);
		const { work, run, dispatcher, executor } = await workingPair(world);
		const assign = async (
			keys: KeyStore,
			name: string,
			roles: readonly Role[],
		) => {
			const outcome = await world.authority.assign(
				{
					memberId: (await keys.open()).memberId,
					request: create(MembershipRequestSchema, {
						fleet: trunk,
						name,
						roles: [...roles],
					}),
				},
				world.admin,
			);
			if (!outcome.ok) throw new Error(`assign: ${outcome.error.message}`);
		};
		await assign(dispatcher.keys, "dispatch", [Role.DISPATCHER]);
		work.add("trunk-job", trunk);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(succeeded(receipts)).toHaveLength(0);

		await assign(executor.keys, "runner", [Role.EXECUTOR]);
		// The next beat reads the new record and restarts the executor in both fleets.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(
			executor.agent.status().member?.memberships.map((m) => m.fleet),
		).toEqual([FLEET, trunk]);
		work.add("trunk-job-2", trunk);
		// The offer made before it joined still stands, so it runs too (L42).
		await until(() => succeeded(receipts).length === 2);
		expect(run.ran).toEqual(["trunk-job", "trunk-job-2"]);
		await dispatcher.agent.stop();
		await executor.agent.stop();
	});
});

describe("observations, control and keys", () => {
	it("publishes a signed observation of itself every 10 s with its tiers, version and region, and one for each sponsored member", async () => {
		const world = await createWorld(now);
		const backend = parseMemberId(`bkd_${"a".repeat(32)}`);
		const { agent, keys } = await enrolled(world, "box", [Role.EXECUTOR], {
			now,
			sponsored: [
				{
					memberId: backend,
					observe: async () =>
						create(ObservationSchema, {
							health: Health.REACHABLE,
							fleets: [FLEET],
						}),
				},
			],
		});
		await agent.start();
		await vi.advanceTimersByTimeAsync(10_000);
		const self = (await keys.open()).memberId;
		const { observations } = await world.bus.observations.read(100);
		const own = observations.filter((keyed) => keyed.memberId === self);
		const theirs = observations.filter((keyed) => keyed.memberId === backend);
		expect(own.length).toBeGreaterThanOrEqual(1);
		expect(theirs.length).toBeGreaterThanOrEqual(1);
		const latest: Observation = fromBinary(
			ObservationSchema,
			own.at(-1)?.envelope.payload ?? new Uint8Array(),
		);
		expect(latest).toMatchObject({
			memberId: self,
			observerId: self,
			fleets: [FLEET],
			health: Health.REACHABLE,
			agentVersion: "1.0.0",
			region: "eu-west",
			sandboxTiers: [
				SandboxTier.S1_CONTAINER,
				SandboxTier.S2_USER_KERNEL,
				SandboxTier.S3_MICROVM,
			],
		});
		expect(own.at(-1)?.envelope.keyId).toBe(`${self}#sign`);
		const sponsored = fromBinary(
			ObservationSchema,
			theirs.at(-1)?.envelope.payload ?? new Uint8Array(),
		);
		expect(sponsored.observerId).toBe(self);
		expect(theirs.at(-1)?.observerId).toBe(self);

		await agent.drain();
		const drained = (await world.bus.observations.read(100)).observations
			.filter((keyed) => keyed.memberId === self)
			.at(-1);
		expect(
			fromBinary(
				ObservationSchema,
				drained?.envelope.payload ?? new Uint8Array(),
			).health,
		).toBe(Health.DRAINING);
		await agent.stop();
	});

	it("stops its work when the authority revokes it, and ignores a control message the authority did not sign", async () => {
		const world = await createWorld(now);
		const lines = logs();
		const { agent, keys } = await enrolled(world, "box", [Role.EXECUTOR], {
			now,
			log: lines.log,
		});
		await agent.start();
		const self = (await keys.open()).memberId;
		const stranger = testKey("authority#1", KeyPurpose.AUTHORITY);
		await world.bus.control.send(
			await signEnvelope(
				stranger.signer,
				CONTROL_CONTEXT,
				toBinary(
					MemberControlSchema,
					create(MemberControlSchema, {
						memberId: self,
						kind: ControlKind.REVOKED,
						reason: "forged",
					}),
				),
			),
			self,
		);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(lines.lines.map((line) => line.event)).not.toContain(
			"hobo_fleet_member_revoked",
		);

		const revoked = await world.authority.revoke(
			{
				memberId: self,
				request: create(LifecycleRequestSchema, { reason: "lost" }),
			},
			world.admin,
		);
		expect(revoked.ok).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(
			lines.lines.find((line) => line.event === "hobo_fleet_member_revoked")
				?.fields,
		).toMatchObject({ member: self, reason: "lost" });
		await agent.stop();
	});

	it("enrolls with a short bundle when policy refuses a day, and renews it at three quarters of its life", async () => {
		const world = await createWorld(now);
		const short = parseFleetId("short");
		await world.defineFleet(short, 1);
		const { agent, keys, response } = await enrolled(
			world,
			"box",
			[Role.EXECUTOR],
			{ now },
			short,
		);
		const bundleSequence = (record: MemberRecord | undefined) =>
			fromBinary(
				KeyBundleSchema,
				record?.keyBundle?.payload ?? new Uint8Array(),
			).sequence;
		const first = fromBinary(
			MemberRecordSchema,
			response.memberRecord?.payload ?? new Uint8Array(),
		);
		expect(bundleSequence(first)).toBe(1);
		await agent.start();
		await vi.advanceTimersByTimeAsync(20 * 60_000);
		await world.authority.tick();
		expect(bundleSequence(await memberOf(world, keys))).toBe(1);
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		await world.authority.tick();
		expect(bundleSequence(await memberOf(world, keys))).toBe(2);
		expect((await memberOf(world, keys))?.state).toBe(MemberState.ACTIVE);
		await agent.stop();
	});

	it("logs its clock skew against the authority's Date header (F16)", async () => {
		const world = await createWorld(now);
		const lines = logs();
		const skewed: typeof fetch = async (input, init) => {
			const response = await world.http.fetch(input, init);
			const headers = new Headers(response.headers);
			headers.set("date", new Date(now() + 120_000).toUTCString());
			return new Response(await response.text(), {
				status: response.status,
				headers,
			});
		};
		const { agent } = await enrolled(world, "box", [Role.EXECUTOR], {
			now,
			log: lines.log,
			fetch: skewed,
		});
		expect(
			lines.lines.find((line) => line.event === "hobo_fleet_clock_skew")
				?.fields,
		).toEqual({ skew_ms: -120_000 });
		await agent.stop();
	});
});
