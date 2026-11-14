/**
 * A recording fake `FleetClient`, recording local functions and a scripted
 * `FleetIo` for the `hobo fleet` command tests. Every client method and every
 * `FleetLocal` function appends its name to `calls`; `FleetIo` does not, since
 * the "Calls" column of §6.15 names none of it.
 */
import { create, toBinary } from "@bufbuild/protobuf";
import {
	AuditCheckpointSchema,
	AuditCheckpointsSchema,
	AuditEntriesSchema,
	AuditEntrySchema,
	AuthorityDiscoverySchema,
	Availability,
	CredentialResponseSchema,
	DiscoverySchema,
	EnrollmentResponseSchema,
	type FleetClient,
	type FleetFailure,
	FleetListSchema,
	FleetRecordSchema,
	type FleetStream,
	FleetVerdictSchema,
	FleetViewSchema,
	KeyAlgorithm,
	KeyRotationRequestSchema,
	MemberListSchema,
	MemberRecordSchema,
	MemberState,
	type Outcome,
	PersonCredentialSchema,
	parseKeyId,
	SandboxTier,
	SessionPartySchema,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	SignInChallengeSchema,
	TokenCreateResponseSchema,
	TokenListSchema,
	WitnessedEnvelopeSchema,
	WorkLogsSchema,
	WorkStatusSchema,
} from "@hobo/fleet";
import type {
	EnrollingDevice,
	FleetCommandDeps,
	FleetIo,
	FleetLocal,
	SignInKey,
} from "../../src/fleet-command.js";

export const TOKEN_TEXT = `hft_${"A".repeat(43)}`;

function envelope(context: string, payload: Uint8Array): SignedEnvelope {
	return create(SignedEnvelopeSchema, {
		context,
		keyId: "authority#1",
		algorithm: KeyAlgorithm.EDDSA,
		payload,
		signature: new Uint8Array(64),
	});
}

export function memberEnvelope(id = "m_device"): SignedEnvelope {
	return envelope(
		"hobo-fleet/member-record/v1",
		toBinary(
			MemberRecordSchema,
			create(MemberRecordSchema, {
				memberId: id,
				tenant: "acme",
				displayName: "Laptop",
				state: MemberState.ACTIVE,
				memberships: [{ fleet: "builds", name: "laptop", roles: [] }],
			}),
		),
	);
}

export function fleetEnvelope(id: string): SignedEnvelope {
	return envelope(
		"hobo-fleet/fleet-record/v1",
		toBinary(
			FleetRecordSchema,
			create(FleetRecordSchema, { fleetId: id, tenant: "acme", revision: 3 }),
		),
	);
}

export function viewEnvelope(id: string): SignedEnvelope {
	return envelope(
		"hobo-fleet/fleet-view/v1",
		toBinary(
			FleetViewSchema,
			create(FleetViewSchema, {
				fleet: id,
				asOf: "2026-11-13T00:00:00.000Z",
				members: [
					{
						memberId: "m_box",
						name: "box",
						state: MemberState.ACTIVE,
						availability: Availability.LIVE,
						capacity: {
							freeSlots: 2,
							totalSlots: 4,
							freeMemoryMb: 2048,
							freeDiskMb: 512,
						},
						reliability: 0.99,
						samples: { delivered: 99, dropped: 1 },
						sandboxTiers: [
							SandboxTier.S1_CONTAINER,
							SandboxTier.S2_USER_KERNEL,
						],
					},
				],
				capacity: {
					live: 1,
					healthy: 1,
					totalSlots: 4,
					freeSlots: 2,
					freeMemoryMb: 2048,
					freeDiskMb: 512,
				},
			}),
		),
	);
}

const checkpoint = create(WitnessedEnvelopeSchema, {
	authority: envelope(
		"hobo-fleet/audit-checkpoint/v1",
		toBinary(
			AuditCheckpointSchema,
			create(AuditCheckpointSchema, { sequence: 2, entryHash: "ab" }),
		),
	),
});

const fakeSigner = {
	keyId: parseKeyId("authority#1"),
	algorithm: KeyAlgorithm.ES256,
	sign: async () => new Uint8Array(64),
};

export const SIGN_IN_KEY: SignInKey = {
	signer: fakeSigner,
	publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
	thumbprint: "thumb",
};

export const DEVICE: EnrollingDevice = {
	...SIGN_IN_KEY,
	memberId: "m_device",
	identityJwk: '{"kty":"EC","crv":"P-256","x":"x","y":"y"}',
};

// domain-view: how the fakes answer; tests override single entries.
export type FakeScript = {
	pollPending: number;
	failures: Partial<Record<keyof FleetClient, FleetFailure>>;
};

function answer<T>(
	calls: string[],
	script: FakeScript,
	name: keyof FleetClient,
	value: T,
): Promise<Outcome<T>> {
	calls.push(`client.${name}`);
	const failure = script.failures[name];
	return Promise.resolve(
		failure === undefined ? { ok: true, value } : { ok: false, error: failure },
	);
}

export function recordingClient(
	calls: string[],
	script: FakeScript,
): FleetClient {
	const a = <T>(name: keyof FleetClient, value: T) =>
		answer(calls, script, name, value);
	return {
		authorityDiscovery: () =>
			a(
				"authorityDiscovery",
				create(AuthorityDiscoverySchema, { issuer: "https://fleet.test" }),
			),
		discovery: () =>
			a(
				"discovery",
				create(DiscoverySchema, {
					tenant: "acme",
					natsUrls: ["nats://bus.test:4222"],
					relayUrls: ["https://relay.test"],
				}),
			),
		jwks: () => a("jwks", { jwks: '{"keys":[]}' }),
		signInStart: () =>
			a(
				"signInStart",
				create(SignInChallengeSchema, {
					state: "state-1",
					authorizeUrl: "https://idp.test/authorize",
					userCode: "WXYZ-1234",
					verificationUrl: "https://fleet.test/device",
					expiresAt: "2999-01-01T00:00:00.000Z",
					intervalSeconds: 1,
				}),
			),
		signInComplete: () =>
			a(
				"signInComplete",
				create(PersonCredentialSchema, {
					token: "person-token",
					principal: "user:ada",
					tenant: "acme",
				}),
			),
		signInPoll: () => {
			if (script.pollPending > 0) {
				script.pollPending -= 1;
				calls.push("client.signInPoll");
				return Promise.resolve({
					ok: false,
					error: { code: "sign-in-pending", message: "waiting" },
				});
			}
			return a(
				"signInPoll",
				create(PersonCredentialSchema, {
					token: "person-token",
					principal: "user:ada",
					tenant: "acme",
				}),
			);
		},
		signInRefresh: () => a("signInRefresh", create(PersonCredentialSchema, {})),
		issueToken: () =>
			a(
				"issueToken",
				create(TokenCreateResponseSchema, {
					token: TOKEN_TEXT,
					tokenHash: "f".repeat(64),
					expiresAt: "2026-11-13T01:00:00.000Z",
				}),
			),
		listTokens: () =>
			a(
				"listTokens",
				create(TokenListSchema, {
					tokens: [{ tokenHash: "f".repeat(64), fleet: "builds", name: "box" }],
				}),
			),
		revokeToken: () => a("revokeToken", create(TokenListSchema, {})),
		enroll: () =>
			a(
				"enroll",
				create(EnrollmentResponseSchema, { memberRecord: memberEnvelope() }),
			),
		declare: () =>
			a(
				"declare",
				create(EnrollmentResponseSchema, {
					memberRecord: memberEnvelope("m_backend"),
				}),
			),
		approveKey: () => a("approveKey", memberEnvelope()),
		accept: () => a("accept", memberEnvelope()),
		reject: () => a("reject", memberEnvelope()),
		suspend: () => a("suspend", memberEnvelope()),
		resume: () => a("resume", memberEnvelope()),
		unlock: () => a("unlock", memberEnvelope()),
		revoke: () => a("revoke", memberEnvelope()),
		assign: () => a("assign", memberEnvelope()),
		credentials: () =>
			a("credentials", create(CredentialResponseSchema, { svid: "svid" })),
		rotateKeys: () => a("rotateKeys", memberEnvelope()),
		leave: () => a("leave", memberEnvelope()),
		listMembers: () =>
			a(
				"listMembers",
				create(MemberListSchema, { members: [memberEnvelope()] }),
			),
		getMember: () => a("getMember", memberEnvelope()),
		listFleets: () =>
			a(
				"listFleets",
				create(FleetListSchema, {
					fleets: [fleetEnvelope("builds"), fleetEnvelope("cache")],
				}),
			),
		getFleet: () => a("getFleet", fleetEnvelope("builds")),
		defineFleet: () => a("defineFleet", fleetEnvelope("builds")),
		fleetView: (request) => a("fleetView", viewEnvelope(request.fleetId)),
		fleetVerdict: () =>
			a(
				"fleetVerdict",
				create(FleetVerdictSchema, {
					fleet: "builds",
					label: "hobo",
					state: 1,
					members: 1,
					freeSlots: 2,
				}),
			),
		grantSession: () =>
			a(
				"grantSession",
				envelope("hobo-fleet/session-grant/v1", new Uint8Array()),
			),
		submitWork: () =>
			a(
				"submitWork",
				create(WorkStatusSchema, { submissionId: "s1", workDigest: "w1" }),
			),
		workStatus: () =>
			a(
				"workStatus",
				create(WorkStatusSchema, {
					submissionId: "s1",
					status: 2,
					memberId: "m_box",
				}),
			),
		workLogs: () =>
			a(
				"workLogs",
				create(WorkLogsSchema, {
					chunks: [{ data: new TextEncoder().encode("hello\n") }],
					complete: true,
				}),
			),
		report: () => a("report", memberEnvelope()),
		auditCheckpoints: () =>
			a(
				"auditCheckpoints",
				create(AuditCheckpointsSchema, { checkpoints: [checkpoint] }),
			),
		auditEntries: () =>
			a(
				"auditEntries",
				create(AuditEntriesSchema, {
					entries: [
						create(AuditEntrySchema, { sequence: 1 }),
						create(AuditEntrySchema, { sequence: 2 }),
					],
				}),
			),
	};
}

/** A stream that answers a shell or forward exchange with OUTPUT "ok" and EXIT 0, or one blob. */
export function scriptedStream(): FleetStream {
	const output = Buffer.from("ok\n");
	const header = Buffer.alloc(5);
	header.writeUInt8(4, 0);
	header.writeUInt32BE(output.length, 1);
	const exit = Buffer.alloc(9);
	exit.writeUInt8(5, 0);
	exit.writeUInt32BE(4, 1);
	exit.writeInt32BE(0, 5);
	return {
		peer: "peer",
		async *read() {
			yield new Uint8Array(Buffer.concat([header, output, exit]));
		},
		async write() {},
		async close() {
			return { bytesSent: 0, bytesReceived: 0 };
		},
	};
}

export function recordingLocal(calls: string[]): FleetLocal {
	const note = (name: keyof FleetLocal) => calls.push(`local.${name}`);
	return {
		async deletePersonToken() {
			note("deletePersonToken");
		},
		async generateKeys() {
			note("generateKeys");
			return { ok: true, value: DEVICE };
		},
		async startAgent() {
			note("startAgent");
			return { ok: true, value: "The agent stopped." };
		},
		async installService(action) {
			note("installService");
			return { ok: true, value: `service ${action}` };
		},
		async loadKeyStore() {
			note("loadKeyStore");
			return { ok: true, value: "m_device" };
		},
		async sandboxDrivers() {
			note("sandboxDrivers");
			return [SandboxTier.S1_CONTAINER];
		},
		async busConnect() {
			note("busConnect");
			return { ok: true, value: "connected" };
		},
		async transportSelfDial() {
			note("transportSelfDial");
			return { ok: true, value: "p2p" };
		},
		async dial() {
			note("dial");
			return { ok: true, value: scriptedStream() };
		},
		async *fetchBlob() {
			note("fetchBlob");
			yield new TextEncoder().encode("blob");
		},
		async verifyAuditChain(entries) {
			note("verifyAuditChain");
			return { ok: true, value: { entries: entries.length, finalThrough: 2 } };
		},
		async deleteKeys() {
			note("deleteKeys");
		},
		async provisionTopology() {
			note("provisionTopology");
			return { ok: true, value: "provisioned" };
		},
		async runCeremony() {
			note("runCeremony");
			return {
				ok: true,
				value: {
					operatorPublicKey: "OPUB",
					shares: ["hobo-fleet-share:1:x", "hobo-fleet-share:2:y"],
				},
			};
		},
		async rotateKey() {
			note("rotateKey");
			return { ok: true, value: { reached: "done" } };
		},
		async backup() {
			note("backup");
			return { ok: true, value: { manifestDigest: "d" } };
		},
		async restore() {
			note("restore");
			return { ok: true, value: { incarnation: 2 } };
		},
	};
}

export type IoLog = {
	written: Record<string, string>;
	stdout: string[];
	progress: string[];
	opened: string[];
	savedPerson: number;
};

export function scriptedIo(
	client: FleetClient,
	log: IoLog,
	overrides: Partial<FleetIo> = {},
): FleetIo {
	return {
		env: { HOBO_FLEET_TENANT: "acme" },
		tenant: () => "acme",
		now: () => Date.parse("2026-11-13T00:00:00.000Z"),
		sleep: async () => {},
		readSecret: async () => TOKEN_TEXT,
		readText: async () => '{"fleetId":"builds","tenant":"acme"}',
		writeText: async (path, text) => {
			log.written[path] = text;
		},
		readStdin: async () => new TextEncoder().encode("echo hi\n"),
		writeStdout: async (bytes) => {
			log.stdout.push(Buffer.from(bytes).toString("utf8"));
		},
		newSignInKey: () => SIGN_IN_KEY,
		savePerson: async () => {
			log.savedPerson += 1;
		},
		agentEnroll: (request) => client.enroll({ ...request, identityJwk: "{}" }),
		saveEnrollment: async () => ({ ok: true, value: "Saved." }),
		openUrl: (url) => {
			log.opened.push(url);
		},
		loopback: async () => ({
			redirectUri: "http://127.0.0.1:5000/callback",
			result: Promise.resolve({ state: "state-1", code: "code-1" }),
			close: () => {},
		}),
		prepareInitiator: async () => ({
			ok: true,
			value: {
				party: create(SessionPartySchema, {
					principal: "user:ada",
					transportIdentity: "endpoint",
					sealPublicKey: "seal",
				}),
				transports: [],
				stop: async () => {},
			},
		}),
		deviceMemberId: async () => ({ ok: true, value: "m_device" }),
		rotationRequest: async () => ({
			ok: true,
			value: {
				memberId: "m_device",
				request: create(KeyRotationRequestSchema, {}),
			},
		}),
		forward: async (_port, serve) => {
			await serve(new TextEncoder().encode("GET / HTTP/1.0\r\n\r\n"));
		},
		progress: (message) => {
			log.progress.push(message);
		},
		platform: "linux",
		arch: "x64",
		hostName: "laptop",
		...overrides,
	};
}

export function fakeDeps(
	options: Readonly<{
		pollPending?: number;
		failures?: FakeScript["failures"];
		io?: Partial<FleetIo>;
	}> = {},
) {
	const calls: string[] = [];
	const auths: string[] = [];
	const script: FakeScript = {
		pollPending: options.pollPending ?? 0,
		failures: options.failures ?? {},
	};
	const client = recordingClient(calls, script);
	const log: IoLog = {
		written: {},
		stdout: [],
		progress: [],
		opened: [],
		savedPerson: 0,
	};
	const deps: FleetCommandDeps = {
		client: async (auth) => {
			auths.push(auth.kind);
			return { ok: true, value: client };
		},
		local: recordingLocal(calls),
		io: scriptedIo(client, log, options.io),
	};
	return { deps, calls, auths, log };
}
