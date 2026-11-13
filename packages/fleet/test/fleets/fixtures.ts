// Test harness for the fleet commands (L32): a memory bus and event store, an
// allow-by-tag policy engine, an Ed25519 record signer, and helpers that put
// member records straight into the registry (the enrollment lane's job, which
// these tests do not exercise).
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import {
	create,
	type DescMessage,
	fromBinary,
	toBinary,
} from "@bufbuild/protobuf";
import {
	allowDecision,
	denyDecision,
	type PolicyEngine,
	type PrincipalRef,
	parseTenantId,
	type TenantId,
} from "@hobo/core";
import {
	ApprovalMode,
	CoordinationMode,
	DeviceClass,
	FleetPolicySchema,
	type FleetRecord,
	FleetRecordSchema,
	KeyAlgorithm,
	KeyBundleSchema,
	KeyPurpose,
	MemberKind,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	PublicKeyRefSchema,
	Role,
} from "../../src/_generated/fleet_pb.js";
import {
	KEY_BUNDLE_CONTEXT,
	MEMBER_RECORD_CONTEXT,
} from "../../src/contexts.js";
import { POLICY_DECIDED_EVENT } from "../../src/events.js";
import { createFleetCommands } from "../../src/fleets/index.js";
import { type MemberId, parseKeyId, parseMemberId } from "../../src/ids.js";
import { signEnvelope } from "../../src/keys/index.js";
import type {
	AuthorityBus,
	FleetCommands,
	FleetEventStore,
	FleetLogEvent,
	Outcome,
	PolicyDecisionRecorder,
	Signer,
	VerifiedToken,
} from "../../src/ports.js";
import {
	createMemoryBus,
	createMemoryEventStore,
} from "../../src/testing/plumbing/index.js";

export const TENANT = parseTenantId("acme");
export const OTHER_TENANT = parseTenantId("other");
export const START_MS = Date.parse("2026-11-01T10:00:00.000Z");
const HOUR_MS = 3_600_000;

/** What `create` accepts for a message. */
export type InitOf<S extends DescMessage> = NonNullable<
	Parameters<typeof create<S>>[1]
>;

/** What a test may set on a fleet policy. */
export type PolicyInit = InitOf<typeof FleetPolicySchema>;

export type TestClock = Readonly<{
	now: () => number;
	advance(ms: number): void;
}>;

export function testClock(start = START_MS): TestClock {
	let at = start;
	return { now: () => at, advance: (ms) => (at += ms) };
}

/** Allow when the subject carries `fleet-admin` or the action itself as a tag; a device with any role may ask for a session grant. */
export function allowByTag(): PolicyEngine {
	const engineId = "l32-test-allow-by-tag";
	return {
		engineId,
		async evaluate(request) {
			const tags = request.subject.tags;
			const deviceSession =
				request.action === "fleet.session.grant" &&
				tags.some((tag) => tag.startsWith("role:"));
			return tags.includes("fleet-admin") ||
				tags.includes(request.action) ||
				deviceSession
				? allowDecision(engineId, request, ["tag allows"])
				: denyDecision(engineId, request, ["no tag allows"]);
		},
	};
}

function decisionRecorder(): PolicyDecisionRecorder {
	return {
		toEvent(request, decision) {
			return {
				type: POLICY_DECIDED_EVENT,
				data: {
					action: request.action,
					effect: decision.effect,
					subject: request.subject.identity,
					resourceId: request.resource.id,
				},
			};
		},
	};
}

export type RawKey = Readonly<{ signer: Signer; raw: string }>;

export function ed25519(keyId: string): RawKey {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return {
		signer: {
			keyId: parseKeyId(keyId),
			algorithm: KeyAlgorithm.EDDSA,
			sign: async (bytes) => new Uint8Array(signBytes(null, bytes, privateKey)),
		},
		raw: publicKey
			.export({ format: "der", type: "spki" })
			.subarray(-32)
			.toString("base64url"),
	};
}

export type Logged = Readonly<{
	event: FleetLogEvent;
	fields: Readonly<Record<string, string | number | boolean>>;
}>;

export type Harness = Readonly<{
	clock: TestClock;
	bus: AuthorityBus;
	store: FleetEventStore;
	authorityKey: RawKey;
	logged: Logged[];
	/** A second instance of the commands on the same store and bus. */
	commands: FleetCommands;
	another(): FleetCommands;
	admin: VerifiedToken;
	person(tags: readonly string[], id?: string): VerifiedToken;
	device(memberId: MemberId, tenant?: TenantId): VerifiedToken;
	account(scopes?: readonly string[]): VerifiedToken;
	workload(repository: string, tenant?: TenantId): VerifiedToken;
	/** Defines a fleet through the commands, as the admin, and returns its record. */
	fleet(
		id: string,
		policy?: PolicyInit,
		coordination?: CoordinationMode,
	): Promise<FleetRecord>;
	/** Puts a member record straight into the registry. */
	member(input: MemberInput): Promise<MemberRecord>;
}>;

export type HarnessOptions = Partial<{
	mode: "authority" | "local";
	store: FleetEventStore;
	policy: PolicyEngine;
	bus: AuthorityBus;
}>;

export function harness(options: HarnessOptions = {}): Harness {
	const clock = testClock();
	const bus = options.bus ?? createMemoryBus(clock.now);
	const store = options.store ?? createMemoryEventStore();
	const authorityKey = ed25519("authority#1");
	const logged: Logged[] = [];
	const build = (): FleetCommands =>
		createFleetCommands({
			tenant: TENANT,
			store,
			bus,
			policy: options.policy ?? allowByTag(),
			decisions: decisionRecorder(),
			recordSigner: authorityKey.signer,
			now: clock.now,
			log: (event, fields) => logged.push({ event, fields }),
			mode: options.mode ?? "authority",
		});
	const commands = build();
	const expires = () => clock.now() + HOUR_MS;
	const person = (tags: readonly string[], id = "admin"): VerifiedToken => ({
		kind: "person",
		principal: { kind: "user", id },
		tenant: TENANT,
		tags,
		jkt: "jkt-person",
		expiresAtMs: expires(),
	});
	const admin = person(["fleet-admin"]);
	const h: Harness = {
		clock,
		bus,
		store,
		authorityKey,
		logged,
		commands,
		another: build,
		admin,
		person,
		device: (memberId, tenant = TENANT) => ({
			kind: "member",
			memberId,
			tenant,
			jkt: "jkt-device",
			expiresAtMs: expires(),
		}),
		account: (scopes = ["fleet.work.submit"]) => ({
			kind: "account",
			principal: { kind: "service", id: "relay" },
			tenant: TENANT,
			scopes,
		}),
		workload: (repository, tenant = TENANT) => ({
			kind: "workload",
			issuer: "https://token.actions.githubusercontent.com",
			subject: `repo:${repository}:ref:refs/heads/main`,
			repository,
			tenant,
			expiresAtMs: expires(),
		}),
		async fleet(id, policy = {}, coordination = CoordinationMode.MANY_ACTIVE) {
			const defined = await commands.defineFleet(
				fleetRecord(id, policy, coordination),
				admin,
			);
			if (!defined.ok)
				throw new Error(`could not define ${id}: ${defined.error.message}`);
			return decodeFleet(defined.value.payload);
		},
		async member(input) {
			const record = memberRecord(input, clock.now());
			await bus.publisher.putMember(
				await signEnvelope(
					authorityKey.signer,
					MEMBER_RECORD_CONTEXT,
					toBinary(MemberRecordSchema, record),
				),
				parseMemberId(record.memberId),
			);
			return record;
		},
	};
	return h;
}

export function fleetRecord(
	id: string,
	policy: PolicyInit = {},
	coordination = CoordinationMode.MANY_ACTIVE,
): FleetRecord {
	return create(FleetRecordSchema, {
		fleetId: id,
		coordination,
		policy: create(FleetPolicySchema, {
			approval: ApprovalMode.SINGLE,
			allowedKinds: [MemberKind.DEVICE],
			allowedRoles: [Role.EXECUTOR, Role.DISPATCHER],
			...policy,
		}),
	});
}

/** A one-active fleet record that satisfies every §7.2 constraint. */
export function oneActiveRecord(id: string): FleetRecord {
	return fleetRecord(
		id,
		{
			allowedKinds: [MemberKind.BACKEND],
			allowedRoles: [],
			failoverAfterMs: 30_000,
		},
		CoordinationMode.ONE_ACTIVE,
	);
}

export function decodeFleet(payload: Uint8Array): FleetRecord {
	return fromBinary(FleetRecordSchema, payload);
}

export type MemberInput = Readonly<{
	memberId: string;
	state?: MemberState;
	kind?: MemberKind;
	fleets: readonly Readonly<{ fleet: string; name: string; roles?: Role[] }>[];
	transport?: string;
	seal?: string;
	sign?: string;
	owner?: PrincipalRef;
}>;

/** A member record whose key bundle carries SIGN, SEAL and (unless empty) TRANSPORT keys. */
function memberRecord(input: MemberInput, nowMs: number): MemberRecord {
	const kind = input.kind ?? MemberKind.DEVICE;
	const id = input.memberId;
	const keys = [
		create(PublicKeyRefSchema, {
			purpose: KeyPurpose.SIGN,
			keyId: `${id}#sign`,
			algorithm: KeyAlgorithm.EDDSA,
			value: input.sign ?? `sign-${id}`,
		}),
		create(PublicKeyRefSchema, {
			purpose: KeyPurpose.SEAL,
			keyId: `${id}#seal`,
			algorithm: KeyAlgorithm.UNSPECIFIED,
			value: input.seal ?? `seal-${id}`,
		}),
	];
	if (input.transport !== "")
		keys.push(
			create(PublicKeyRefSchema, {
				purpose: KeyPurpose.TRANSPORT,
				keyId: `${id}#transport`,
				algorithm: KeyAlgorithm.UNSPECIFIED,
				value: input.transport ?? `endpoint-${id}`,
			}),
		);
	const bundle = toBinary(
		KeyBundleSchema,
		create(KeyBundleSchema, {
			memberId: id,
			sequence: 1,
			keys,
			issuedAt: new Date(nowMs).toISOString(),
			notAfter: new Date(nowMs + 24 * HOUR_MS).toISOString(),
		}),
	);
	const owner = input.owner ?? { kind: "user", id: "admin" };
	return create(MemberRecordSchema, {
		memberId: id,
		tenant: TENANT,
		kind,
		displayName: id,
		state: input.state ?? MemberState.ACTIVE,
		memberships: input.fleets.map((entry) => ({
			fleet: entry.fleet,
			name: entry.name,
			roles: kind === MemberKind.DEVICE ? (entry.roles ?? [Role.EXECUTOR]) : [],
		})),
		deviceClass:
			kind === MemberKind.DEVICE
				? DeviceClass.DEDICATED
				: DeviceClass.UNSPECIFIED,
		keyBundle:
			kind === MemberKind.DEVICE
				? {
						context: KEY_BUNDLE_CONTEXT,
						keyId: `${id}#identity`,
						algorithm: KeyAlgorithm.ES256,
						payload: bundle,
						signature: new Uint8Array(64),
					}
				: undefined,
		owner: `${owner.kind}:${owner.id}`,
		sponsor: kind === MemberKind.DEVICE ? "" : "user:admin",
		credentialRef: kind === MemberKind.DEVICE ? "" : "vault://backend",
		recordSequence: 1,
		issuedAt: new Date(nowMs).toISOString(),
		notAfter: new Date(nowMs + 30 * 60_000).toISOString(),
	});
}

export function dev(n: number): MemberId {
	return parseMemberId(`dev_${n.toString(16).padStart(32, "0")}`);
}

export function errorOf<T>(outcome: Outcome<T>): string {
	return outcome.ok ? "ok" : outcome.error.code;
}

export function unwrap<T>(outcome: Outcome<T>): T {
	if (!outcome.ok)
		throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
	return outcome.value;
}
