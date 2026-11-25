import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	CoordinationMode,
	type FleetRecord,
	FleetRecordSchema,
	KeyAlgorithm,
	KeyPurpose,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	type PublicKeyRef,
	PublicKeyRefSchema,
	SandboxTier,
	type SessionGrant,
	SessionGrantSchema,
	SessionPurpose,
	type SignedEnvelope,
	TrustRecordSchema,
} from "../../src/_generated/fleet_pb.js";
import { SESSION_GRANT_CONTEXT } from "../../src/contexts.js";
import {
	type FleetId,
	type MemberId,
	parseFleetId,
	parseKeyId,
} from "../../src/ids.js";
import { signEnvelope } from "../../src/keys/index.js";
import type {
	FleetStream,
	FleetTransport,
	Outcome,
	RegistryView,
	Sandbox,
	Signer,
	TransportKind,
} from "../../src/ports.js";

function pipe() {
	const chunks: Uint8Array[] = [];
	let ended = false;
	let wake: (() => void) | undefined;
	const notify = () => {
		wake?.();
		wake = undefined;
	};
	return {
		push(chunk: Uint8Array) {
			if (ended) throw new Error("the stream is closed");
			chunks.push(chunk);
			notify();
		},
		end() {
			ended = true;
			notify();
		},
		async *drain(): AsyncIterable<Uint8Array> {
			for (;;) {
				const next = chunks.shift();
				if (next !== undefined) {
					yield next;
					continue;
				}
				if (ended) return;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
		},
	};
}

export function memoryStreamPair(
	initiator = "initiator",
	acceptor = "acceptor",
): readonly [FleetStream, FleetStream] {
	const forward = pipe();
	const backward = pipe();
	const end = (
		peer: string,
		outgoing: ReturnType<typeof pipe>,
		incoming: ReturnType<typeof pipe>,
	): FleetStream => {
		let sent = 0;
		let received = 0;
		return {
			peer,
			async *read() {
				for await (const chunk of incoming.drain()) {
					received += chunk.length;
					yield chunk;
				}
			},
			async write(chunk) {
				sent += chunk.length;
				outgoing.push(chunk.slice());
			},
			async close() {
				outgoing.end();
				incoming.end();
				return { bytesSent: sent, bytesReceived: received };
			},
		};
	};
	return [end(acceptor, forward, backward), end(initiator, backward, forward)];
}

type Acceptor = Readonly<{
	authorise: (peer: string, grant: SignedEnvelope) => Promise<boolean>;
	handler: (stream: FleetStream, grant: SessionGrant) => Promise<void>;
}>;

export type DialMode = "carry" | "fail" | "throw";

export type MemoryNetwork = Readonly<{
	acceptors: Map<string, Acceptor>;
	dials: TransportKind[];
	handed: TransportKind[];
}>;

export function memoryNetwork(): MemoryNetwork {
	return { acceptors: new Map(), dials: [], handed: [] };
}

export function memoryTransport(
	network: MemoryNetwork,
	kind: TransportKind,
	mode: { dial: DialMode } = { dial: "carry" },
	identityOverride?: string,
): FleetTransport {
	let identity: string | undefined;
	return {
		kind,
		async start(keys) {
			identity = identityOverride ?? `${kind}:${keys.memberId}`;
			return { transportIdentity: identity };
		},
		async dial({ grant, signal }): Promise<Outcome<FleetStream>> {
			network.dials.push(kind);
			if (mode.dial === "throw") throw new Error(`${kind} is down`);
			if (mode.dial === "fail")
				return {
					ok: false,
					error: { code: "unavailable", message: `${kind} is down` },
				};
			if (signal.aborted)
				return {
					ok: false,
					error: { code: "unavailable", message: "aborted" },
				};
			if (identity === undefined)
				return {
					ok: false,
					error: { code: "unavailable", message: "not started" },
				};
			const decoded = fromBinary(SessionGrantSchema, grant.payload);
			const target = network.acceptors.get(
				`${kind}|${decoded.acceptor?.transportIdentity ?? ""}`,
			);
			if (target === undefined)
				return {
					ok: false,
					error: { code: "unavailable", message: "no such acceptor" },
				};
			const [mine, theirs] = memoryStreamPair(
				identity,
				decoded.acceptor?.transportIdentity ?? "",
			);
			if (!(await target.authorise(identity, grant))) {
				await mine.close();
				return {
					ok: false,
					error: { code: "session-denied", message: "not authorised" },
				};
			}
			network.handed.push(kind);
			target.handler(theirs, decoded).catch(() => undefined);
			return { ok: true, value: mine };
		},
		accept(authorise, handler) {
			const own = identity;
			if (own === undefined) throw new Error("accept before start");
			const key = `${kind}|${own}`;
			network.acceptors.set(key, { authorise, handler });
			return {
				async stop() {
					network.acceptors.delete(key);
				},
			};
		},
		async stop() {
			if (identity !== undefined)
				network.acceptors.delete(`${kind}|${identity}`);
		},
	};
}

export type AuthorityKey = Readonly<{ signer: Signer; ref: PublicKeyRef }>;

export function authorityKey(index = 1): AuthorityKey {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const keyId = parseKeyId(`authority#${index}`);
	const jwk = publicKey.export({ format: "jwk" });
	return {
		signer: {
			keyId,
			algorithm: KeyAlgorithm.EDDSA,
			async sign(bytes) {
				return new Uint8Array(signBytes(null, bytes, privateKey));
			},
		},
		ref: create(PublicKeyRefSchema, {
			purpose: KeyPurpose.AUTHORITY,
			keyId,
			algorithm: KeyAlgorithm.EDDSA,
			value: jwk.x ?? "",
		}),
	};
}

export const TENANT = "acme";
export const FLEET: FleetId = parseFleetId("builders");

export function memoryRegistry(authority: AuthorityKey): RegistryView &
	Readonly<{
		putMember(record: MemberRecord): void;
		putFleet(record: FleetRecord): void;
	}> {
	const members = new Map<string, MemberRecord>();
	const fleets = new Map<string, FleetRecord>();
	const trust = create(TrustRecordSchema, {
		tenant: TENANT,
		sequence: 1,
		authorityKeys: [authority.ref],
	});
	return {
		putMember(record) {
			members.set(record.memberId, record);
		},
		putFleet(record) {
			fleets.set(record.fleetId, record);
		},
		async member(id) {
			return members.get(id);
		},
		async fleet(id) {
			return fleets.get(id);
		},
		async membersOf(id) {
			return [...members.values()].filter((member) =>
				member.memberships.some((membership) => membership.fleet === id),
			);
		},
		async fleets() {
			return [...fleets.values()];
		},
		async members() {
			return [...members.values()];
		},
		async view() {
			return undefined;
		},
		trust() {
			return trust;
		},
		trustEnvelope() {
			return undefined;
		},
		async caughtUp() {},
	};
}

export function memberRecord(
	memberId: MemberId,
	state: MemberState = MemberState.ACTIVE,
): MemberRecord {
	return create(MemberRecordSchema, {
		memberId,
		tenant: TENANT,
		state,
		memberships: [{ fleet: FLEET, name: memberId.slice(4, 12) }],
	});
}

export function fleetRecord(
	purposes: readonly SessionPurpose[] = [
		SessionPurpose.SHELL,
		SessionPurpose.FORWARD,
		SessionPurpose.BLOB,
	],
): FleetRecord {
	return create(FleetRecordSchema, {
		fleetId: FLEET,
		tenant: TENANT,
		coordination: CoordinationMode.MANY_ACTIVE,
		policy: { sessionPurposes: [...purposes] },
		revision: 1,
	});
}

export type GrantInput = Readonly<{
	initiator: Readonly<{
		memberId: string;
		principal?: string;
		transportIdentity: string;
	}>;
	acceptor: Readonly<{ memberId: string; transportIdentity: string }>;
	purpose?: SessionPurpose;
	orderId?: string;
	port?: number;
	blobDigests?: readonly string[];
	nowMs?: number;
	expiresInMs?: number;
	sessionId?: string;
	tenant?: string;
}>;

export function grantRecord(input: GrantInput): SessionGrant {
	const now = input.nowMs ?? Date.now();
	return create(SessionGrantSchema, {
		sessionId: input.sessionId ?? `ses_${now.toString(16)}`,
		tenant: input.tenant ?? TENANT,
		initiator: {
			memberId: input.initiator.memberId,
			principal: input.initiator.principal ?? "",
			transportIdentity: input.initiator.transportIdentity,
		},
		acceptor: {
			memberId: input.acceptor.memberId,
			transportIdentity: input.acceptor.transportIdentity,
		},
		purpose: input.purpose ?? SessionPurpose.BLOB,
		orderId: input.orderId ?? "",
		port: input.port ?? 0,
		blobDigests: [...(input.blobDigests ?? [`sha256:${"0".repeat(64)}`])],
		issuedAt: new Date(now - 1_000).toISOString(),
		expiresAt: new Date(now + (input.expiresInMs ?? 600_000)).toISOString(),
	});
}

export function signGrant(
	signer: Signer,
	grant: SessionGrant,
	context: Parameters<typeof signEnvelope>[1] = SESSION_GRANT_CONTEXT,
): Promise<SignedEnvelope> {
	return signEnvelope(signer, context, toBinary(SessionGrantSchema, grant));
}

export function scriptedSandbox(
	script: (
		argv: readonly string[],
		stdin: Uint8Array,
		output: (chunk: Uint8Array) => void,
	) => Promise<number>,
): Sandbox & Readonly<{ runs: string[][] }> {
	const runs: string[][] = [];
	return {
		id: "scripted",
		tier: SandboxTier.S3_MICROVM,
		controlUrl: "http://scripted.sandbox.invalid",
		runs,
		async exec(command) {
			runs.push([...command.argv]);
			const exitCode = await script(
				command.argv,
				command.stdin ?? new Uint8Array(),
				command.onOutput,
			);
			return { exitCode };
		},
		async writeSecret() {},
		async destroy() {},
	};
}
