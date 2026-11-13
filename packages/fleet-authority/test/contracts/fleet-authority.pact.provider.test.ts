/**
 * Provider verification of `packages/fleet/contracts/fleet-authority.pact.json`
 * (the consumer pact `createFleetClient` writes, L07) against the real
 * service: `assembleAuthority` behind `createAuthorityHandler`, reached
 * through the harness's `send()`. Every interaction is replayed, none
 * skipped.
 *
 * For each interaction a fresh service is brought to the interaction's
 * provider state. The state answers what the request carries: the caller (a
 * DPoP-bound token, or a bare DPoP proof key), a request body where the
 * pact's example cannot pass the service's checks (keys and signatures must
 * verify), and the ids the service generated for the example ids in the path
 * and body (the pact's example member id, token hash and submission id).
 * The request actually sent must still match the pact: its body by the
 * pact's rule, its `DPoP` and `Authorization` headers by their regexes, and
 * no credential the pact does not carry. The response must match the pact's
 * status, headers and body rule (see `pact.ts`).
 */
import { readFileSync } from "node:fs";
import { create, toBinary, toJson } from "@bufbuild/protobuf";
import type { JsonValue } from "@hobo/core";
import {
	ApprovalMode,
	CLAIM_CONTEXT,
	ClaimSchema,
	CoordinationMode,
	FleetPolicySchema,
	FleetRecordSchema,
	Health,
	KEY_BUNDLE_CONTEXT,
	KeyAlgorithm,
	KeyBundleSchema,
	KeyPurpose,
	MemberKind,
	OBSERVATION_CONTEXT,
	ObservationSchema,
	OFFER_CONTEXT,
	type OverlayCredentialMinter,
	PublicKeyRefSchema,
	Role,
	SandboxTier,
	SessionPurpose,
	SignedEnvelopeSchema,
	type Signer,
	TrustClass,
	ViolationReportSchema,
	WorkOfferSchema,
	WorkOrigin,
} from "@hobo/fleet";
import { jwkThumbprint, type PublicJwk, signEnvelope } from "@hobo/fleet/keys";
import { workDigest } from "@hobo/fleet/work";
import { describe, expect, it } from "vitest";
import { parseJson } from "../../src/ops/json.js";
import {
	type Caller,
	createHarness,
	credentialBody,
	type Device,
	enrollmentBody,
	type Harness,
	newDevice,
} from "../support/harness.js";
import {
	bodyMismatch,
	headerMismatch,
	type PactInteraction,
	parsePact,
} from "./pact.js";

const PACT = parsePact(
	readFileSync(
		new URL(
			"../../../fleet/contracts/fleet-authority.pact.json",
			import.meta.url,
		),
		"utf8",
	),
);

/** The pact's example ids, replaced by the ids the service generated. */
const EXAMPLE = {
	member: "dev_0123456789abcdef0123456789abcdef",
	tokenHash: "a".repeat(64),
	submission: "sub_1",
} as const;
const FLEET = "hobo";
const TRUNK = "hobo-trunk";

type Key = Readonly<{ signer: Signer; publicJwk: PublicJwk }>;

/** What a provider state hands the replay. */
type Prepared = Readonly<{
	h: Harness;
	caller?: Caller;
	/** A bare DPoP proof key, for a request that carries no token. */
	dpop?: Key;
	/** The body to send instead of the pact's example (it must still match the example by the pact's rule). */
	body?: JsonValue;
	/** Example id → the id the service generated. */
	ids?: Readonly<Record<string, string>>;
}>;

/** An overlay minter, so an enrolled device is answered with a join (§6.12). */
const tailscale: OverlayCredentialMinter = {
	provider: "tailscale",
	async mint(input) {
		return {
			ok: true,
			value: {
				$typeName: "hobo.fleet.v1.OverlayJoin",
				provider: "tailscale",
				credential: `tskey-${input.memberId.slice(-6)}`,
				expiresAt: new Date(Date.parse("2026-11-13T10:10:00Z")).toISOString(),
				tags: [...input.tags],
			},
		};
	},
};

const json = (value: JsonValue | undefined): string =>
	value === undefined ? "" : JSON.stringify(value);

const asJson = (text: string): JsonValue => {
	const parsed = parseJson(text);
	if (parsed === undefined) throw new Error("not JSON");
	return parsed;
};

// ── The service in its states ───────────────────────────────────────────────

type World = Readonly<{ h: Harness; admin: Caller }>;

async function world(
	options: Readonly<{
		approval?: ApprovalMode;
		overlay?: boolean;
		/** Discovery names a bus and a relay. */
		discovery?: boolean;
		fleets?: readonly string[];
	}> = {},
): Promise<World> {
	const h = await createHarness({
		overlayMinters: options.overlay === true ? [tailscale] : [],
		natsUrls: options.discovery === true ? ["tls://nats.fleet.test:4222"] : [],
		relayUrls: options.discovery === true ? ["https://relay.fleet.test"] : [],
	});
	const admin = await h.personCaller({ kind: "user", id: "alice" }, [
		"fleet-admin",
		"auditor",
	]);
	for (const fleet of options.fleets ?? [FLEET])
		await defineFleet(
			{ h, admin },
			fleet,
			options.approval ?? ApprovalMode.AUTO_OWNER,
		);
	return { h, admin };
}

async function defineFleet(
	w: World,
	fleet: string,
	approval: ApprovalMode,
): Promise<void> {
	const record = create(FleetRecordSchema, {
		fleetId: fleet,
		coordination: CoordinationMode.MANY_ACTIVE,
		policy: create(FleetPolicySchema, {
			approval,
			allowedKinds: [MemberKind.DEVICE, MemberKind.BACKEND],
			allowedRoles: [Role.EXECUTOR, Role.DISPATCHER],
			sessionPurposes: [SessionPurpose.SHELL],
			workKinds: ["oci-command"],
			labels: [FLEET],
		}),
	});
	const answer = await w.h.send("PUT", `/v1/fleet/fleets/${fleet}`, {
		caller: w.admin,
		body: JSON.stringify(toJson(FleetRecordSchema, record)),
	});
	if (answer.status !== 200) throw new Error(`define ${fleet}: ${answer.text}`);
	await w.h.runtime.tickOnce();
}

async function issueToken(
	w: World,
	name: string,
	roles: readonly Role[] = [Role.EXECUTOR, Role.DISPATCHER],
): Promise<Readonly<{ token: string; tokenHash: string }>> {
	const answer = await w.h.send("POST", "/v1/fleet/tokens", {
		caller: w.admin,
		body: JSON.stringify({
			fleet: FLEET,
			name,
			displayName: name,
			deviceClass: "DEVICE_CLASS_DEDICATED",
			roles: roles.map((role) => Role[role]).map((role) => `ROLE_${role}`),
			ttlSeconds: 900,
		}),
	});
	if (answer.status !== 200) throw new Error(`token: ${answer.text}`);
	return answer.json();
}

async function enroll(w: World, name: string): Promise<Device> {
	const { token } = await issueToken(w, name);
	const device = await newDevice(w.h.now());
	const answer = await w.h.send("POST", "/v1/fleet/members", {
		body: enrollmentBody(device, FLEET, { bootstrapToken: token }, name),
		dpop: device.identityKey,
	});
	if (answer.status !== 200) throw new Error(`enroll: ${answer.text}`);
	await w.h.runtime.tickOnce();
	return device;
}

/** Refreshes `device` from `generation`, returning its SVID caller and the next generation. */
async function refresh(
	w: World,
	device: Device,
	generation: number,
): Promise<Readonly<{ caller: Caller; generation: number }>> {
	const answer = await w.h.send(
		"POST",
		`/v1/fleet/members/${device.keys.memberId}/credentials`,
		{ body: credentialBody(generation), dpop: device.signKey },
	);
	if (answer.status !== 200) throw new Error(`refresh: ${answer.text}`);
	const issued = answer.json();
	return {
		caller: {
			authorization: `DPoP ${issued.svid}`,
			dpopKey: device.signKey,
			token: issued.svid,
		},
		generation: issued.generation,
	};
}

async function lifecycle(w: World, verb: string, member: string) {
	const answer = await w.h.send("POST", `/v1/fleet/members/${member}/${verb}`, {
		caller: w.admin,
		body: JSON.stringify({ reason: "provider state", fleets: [FLEET] }),
	});
	if (answer.status !== 200) throw new Error(`${verb}: ${answer.text}`);
	await w.h.runtime.tickOnce();
}

const memberIds = (device: Device) => ({
	[EXAMPLE.member]: device.keys.memberId,
});

/** A pending enrollment in a fleet that needs a person's approval. */
async function pending(): Promise<Readonly<{ w: World; device: Device }>> {
	const w = await world({ approval: ApprovalMode.SINGLE });
	return { w, device: await enroll(w, "laptop") };
}

/** An active device, enrolled in a fleet that approves its owner's devices. */
async function active(
	options: Parameters<typeof world>[0] = {},
): Promise<Readonly<{ w: World; device: Device }>> {
	const w = await world(options);
	return { w, device: await enroll(w, "laptop") };
}

async function submitted(): Promise<Readonly<{ w: World; id: string }>> {
	const w = await world();
	const answer = await w.h.send("POST", "/v1/fleet/work", {
		caller: w.admin,
		body: JSON.stringify({
			fleet: FLEET,
			image: "docker.io/library/alpine",
			imageDigest: `sha256:${"c".repeat(64)}`,
			argv: ["echo", "hi"],
			ttlSeconds: 600,
		}),
	});
	if (answer.status !== 200) throw new Error(`submit: ${answer.text}`);
	return { w, id: answer.json().submissionId };
}

async function rotatedBundle(device: Device, nowMs: number) {
	return signEnvelope(
		device.keys.identity,
		KEY_BUNDLE_CONTEXT,
		toBinary(
			KeyBundleSchema,
			create(KeyBundleSchema, {
				memberId: device.keys.memberId,
				sequence: 2,
				keys: [
					create(PublicKeyRefSchema, {
						purpose: KeyPurpose.SIGN,
						keyId: device.keys.sign.keyId,
						algorithm: KeyAlgorithm.EDDSA,
						value: device.keys.signPublicKey,
					}),
					create(PublicKeyRefSchema, {
						purpose: KeyPurpose.SEAL,
						keyId: `${device.keys.memberId}#seal`,
						algorithm: KeyAlgorithm.UNSPECIFIED,
						value: device.keys.sealPublicKey,
					}),
				],
				issuedAt: new Date(nowMs).toISOString(),
				notAfter: new Date(nowMs + 24 * 3_600_000).toISOString(),
			}),
		),
	);
}

/** Three claims of one offer by `victim`, each three ranks ahead of its turn (§6.9 rule 3). */
async function earlyReport(
	w: World,
	dispatcher: Device,
	victim: Device,
): Promise<JsonValue> {
	const nowMs = w.h.now();
	const kind = "oci-command";
	const workKey = "sub_early";
	const offer = create(WorkOfferSchema, {
		workKey,
		workDigest: workDigest(kind, workKey),
		kind,
		fleet: FLEET,
		label: FLEET,
		needs: { labels: [] },
		trustClass: TrustClass.ORG,
		author: "user:alice",
		origin: WorkOrigin.INTERNAL,
		queuedAt: new Date(nowMs).toISOString(),
		expiresAt: new Date(nowMs + 10 * 60_000).toISOString(),
		dispatcher: dispatcher.keys.memberId,
	});
	const claims = await Promise.all(
		[0, 1, 2].map((index) =>
			signEnvelope(
				victim.keys.sign,
				CLAIM_CONTEXT,
				toBinary(
					ClaimSchema,
					create(ClaimSchema, {
						workDigest: offer.workDigest,
						fleet: FLEET,
						memberId: victim.keys.memberId,
						dispatcher: dispatcher.keys.memberId,
						offerExpiresAt: offer.expiresAt,
						rank: 3,
						sandboxTier: SandboxTier.S3_MICROVM,
						claimedAt: new Date(nowMs + index).toISOString(),
					}),
				),
			),
		),
	);
	return toJson(
		ViolationReportSchema,
		create(ViolationReportSchema, {
			kind: "claim-early",
			offer: await signEnvelope(
				dispatcher.keys.sign,
				OFFER_CONTEXT,
				toBinary(WorkOfferSchema, offer),
			),
			claims,
		}),
	);
}

/** Each provider state of the pact, by its name. */
type ProviderStates = Readonly<Record<string, () => Promise<Prepared>>>;

const STATES = new Map(
	Object.entries({
		"an authority is running": async () => ({ h: (await world()).h }),
		"tenant test exists": async () => ({
			h: (await world({ discovery: true })).h,
		}),
		"sign-in provider github is configured": async () => {
			const w = await world();
			const key = (await newDevice(w.h.now())).signKey;
			// The harness's sign-in provider is named "test".
			return {
				h: w.h,
				body: {
					provider: "test",
					tenant: "test",
					redirectUri: "http://127.0.0.1:53682/callback",
					codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
					dpopThumbprint: jwkThumbprint(key.publicJwk),
					hostName: "laptop",
				},
			};
		},
		"sign-in st_1 was approved": async () => {
			const w = await world();
			const flow = await w.h.startSignIn("user:alice");
			const { cookie } = await flow.callback();
			const code = await flow.decide(cookie);
			return {
				h: w.h,
				dpop: flow.key,
				body: { state: flow.state, code, codeVerifier: flow.verifier },
			};
		},
		"device sign-in st_2 is pending": async () => {
			const w = await world();
			const flow = await w.h.startSignIn("user:alice", true);
			return { h: w.h, dpop: flow.key, body: { state: flow.state } };
		},
		"a person token for user:alice is valid": async () => {
			const w = await world();
			return { h: w.h, caller: await w.h.signedIn("user:alice") };
		},
		"fleet hobo exists and user:alice may invite": async () => {
			const w = await world();
			return { h: w.h, caller: w.admin };
		},
		"one bootstrap token is outstanding": async () => {
			const w = await world();
			const { tokenHash } = await issueToken(w, "laptop");
			return {
				h: w.h,
				caller: w.admin,
				ids: { [EXAMPLE.tokenHash]: tokenHash },
			};
		},
		"a bootstrap token for fleet hobo, name laptop, is outstanding":
			async () => {
				const w = await world({ overlay: true });
				const { token } = await issueToken(w, "laptop");
				const device = await newDevice(w.h.now());
				return {
					h: w.h,
					dpop: device.identityKey,
					body: asJson(
						enrollmentBody(device, FLEET, { bootstrapToken: token }, "laptop"),
					),
				};
			},
		"fleet hobo exists and user:alice may declare": async () => {
			const w = await world({ overlay: true });
			return { h: w.h, caller: w.admin };
		},
		[`member ${EXAMPLE.member} exists and user:alice may approve-key`]:
			async () => {
				const { w, device } = await pending();
				return { h: w.h, caller: w.admin, ids: memberIds(device) };
			},
		[`member ${EXAMPLE.member} exists and user:alice may accept`]: async () => {
			const { w, device } = await pending();
			await lifecycle(w, "approve-key", device.keys.memberId);
			return { h: w.h, caller: w.admin, ids: memberIds(device) };
		},
		[`member ${EXAMPLE.member} exists and user:alice may reject`]: async () => {
			const { w, device } = await pending();
			return { h: w.h, caller: w.admin, ids: memberIds(device) };
		},
		[`member ${EXAMPLE.member} exists and user:alice may suspend`]:
			async () => {
				const { w, device } = await active();
				return { h: w.h, caller: w.admin, ids: memberIds(device) };
			},
		[`member ${EXAMPLE.member} exists and user:alice may resume`]: async () => {
			const { w, device } = await active();
			await lifecycle(w, "suspend", device.keys.memberId);
			return { h: w.h, caller: w.admin, ids: memberIds(device) };
		},
		[`member ${EXAMPLE.member} exists and user:alice may unlock`]: async () => {
			const { w, device } = await active();
			// A refresh at a generation the authority never answered locks the device (clone detection).
			const answer = await w.h.send(
				"POST",
				`/v1/fleet/members/${device.keys.memberId}/credentials`,
				{ body: credentialBody(7), dpop: device.signKey },
			);
			if (answer.status !== 423) throw new Error(`lock: ${answer.text}`);
			await w.h.runtime.tickOnce();
			return { h: w.h, caller: w.admin, ids: memberIds(device) };
		},
		[`member ${EXAMPLE.member} exists and user:alice may revoke`]: async () => {
			const { w, device } = await active();
			return { h: w.h, caller: w.admin, ids: memberIds(device) };
		},
		[`member ${EXAMPLE.member} is ACTIVE and fleet ${TRUNK} exists`]:
			async () => {
				const { w, device } = await active({ fleets: [FLEET, TRUNK] });
				return { h: w.h, caller: w.admin, ids: memberIds(device) };
			},
		[`member ${EXAMPLE.member} is ACTIVE at generation 3`]: async () => {
			const { w, device } = await active();
			let generation = 0;
			while (generation < 3)
				({ generation } = await refresh(w, device, generation));
			return {
				h: w.h,
				dpop: device.signKey,
				body: asJson(credentialBody(generation)),
				ids: memberIds(device),
			};
		},
		[`member ${EXAMPLE.member} is ACTIVE at generation 5`]: async () => {
			const { w, device } = await active();
			let generation = 0;
			while (generation < 5)
				({ generation } = await refresh(w, device, generation));
			return {
				h: w.h,
				dpop: device.signKey,
				body: asJson(credentialBody(3)),
				ids: memberIds(device),
			};
		},
		[`member ${EXAMPLE.member} is ACTIVE`]: async () => {
			const { w, device } = await active();
			const { caller } = await refresh(w, device, 0);
			return {
				h: w.h,
				caller,
				ids: memberIds(device),
				// Used by the key rotation (its body); leave carries none.
				body: {
					keyBundle: toJson(
						SignedEnvelopeSchema,
						await rotatedBundle(device, w.h.now()),
					),
				},
			};
		},
		"fleet hobo has members": async () => {
			const { w } = await active();
			return { h: w.h, caller: w.admin };
		},
		[`member ${EXAMPLE.member} exists`]: async () => {
			const { w, device } = await active();
			return { h: w.h, caller: w.admin, ids: memberIds(device) };
		},
		"fleet hobo exists": async () => {
			const w = await world();
			return { h: w.h, caller: w.admin };
		},
		"user:alice may define fleets": async () => {
			const w = await world({ fleets: [] });
			// The pact's example names no coordination or approval mode, which the service requires.
			return {
				h: w.h,
				caller: w.admin,
				body: {
					fleetId: FLEET,
					tenant: "test",
					owner: "user:alice",
					coordination: "COORDINATION_MODE_MANY_ACTIVE",
					policy: {
						approval: "APPROVAL_MODE_AUTO_OWNER",
						sessionPurposes: ["SESSION_PURPOSE_SHELL"],
						keyBundleHours: 24,
					},
				},
			};
		},
		"fleet hobo has a view": async () => {
			const { w } = await active();
			return { h: w.h, caller: w.admin };
		},
		"fleet hobo has one live executor with a free slot": async () => {
			const { w, device } = await active();
			// The projection publishes views every 30 s.
			w.h.time.advance(31_000);
			const nowMs = w.h.now();
			const observation = create(ObservationSchema, {
				memberId: device.keys.memberId,
				observerId: device.keys.memberId,
				fleets: [FLEET],
				health: Health.REACHABLE,
				capacity: { freeSlots: 1 },
				labels: [FLEET],
				platform: { os: "linux", arch: "x64" },
				sandboxTiers: [SandboxTier.S1_CONTAINER],
				agentVersion: "1.2.0",
				region: "eu-west-1",
				issuedAt: new Date(nowMs).toISOString(),
				validUntil: new Date(nowMs + 50_000).toISOString(),
			});
			await w.h.test.bus.observations.publish(
				await signEnvelope(
					device.keys.sign,
					OBSERVATION_CONTEXT,
					toBinary(ObservationSchema, observation),
				),
				device.keys.memberId,
				device.keys.memberId,
			);
			await w.h.runtime.tickOnce();
			return { h: w.h, caller: w.admin };
		},
		[`member ${EXAMPLE.member} runs order 00000000000000000000000000000000 in fleet hobo`]:
			async () => {
				const { w, device } = await active();
				return { h: w.h, caller: w.admin, ids: memberIds(device) };
			},
		"fleet hobo allows oci-command and user:alice may submit": async () => {
			const w = await world();
			return { h: w.h, caller: w.admin };
		},
		"submission sub_1 exists": async () => {
			const { w, id } = await submitted();
			return { h: w.h, caller: w.admin, ids: { [EXAMPLE.submission]: id } };
		},
		"submission sub_1 has logged": async () => {
			const { w, id } = await submitted();
			return { h: w.h, caller: w.admin, ids: { [EXAMPLE.submission]: id } };
		},
		[`a dispatcher of fleet hobo holds an early claim of ${EXAMPLE.member}`]:
			async () => {
				const w = await world();
				const dispatcher = await enroll(w, "dispatch");
				const victim = await enroll(w, "laptop");
				const { caller } = await refresh(w, dispatcher, 0);
				return {
					h: w.h,
					caller,
					body: await earlyReport(w, dispatcher, victim),
					ids: memberIds(victim),
				};
			},
		"the audit chain has checkpoints": async () => {
			const { w } = await active();
			w.h.time.advance(61_000);
			await w.h.runtime.tickOnce();
			await w.h.runtime.tickOnce();
			return { h: w.h, caller: w.admin };
		},
		"the audit chain has entries 1 to 10": async () => {
			const w = await world({ fleets: [FLEET, TRUNK] });
			await enroll(w, "laptop");
			await enroll(w, "desktop");
			await w.h.runtime.tickOnce();
			return { h: w.h, caller: w.admin };
		},
	} satisfies ProviderStates),
);

// ── The replay ─────────────────────────────────────────────────────────────

function substitute(text: string, ids: Readonly<Record<string, string>>) {
	let out = text;
	for (const [example, real] of Object.entries(ids))
		out = out.split(example).join(real);
	return out;
}

async function replay(
	interaction: PactInteraction,
): Promise<readonly string[]> {
	const setup = STATES.get(interaction.providerState);
	if (setup === undefined)
		return [`no provider state "${interaction.providerState}"`];
	const state = await setup();
	const { request, response } = interaction;
	const ids = state.ids ?? {};
	const problems: string[] = [];
	const body =
		request.body === undefined
			? undefined
			: (state.body ?? asJson(substitute(json(request.body), ids)));
	const sentBody = bodyMismatch(request.body, body, request.rules);
	if (sentBody !== undefined) problems.push(`request ${sentBody}`);

	const path = substitute(
		request.query.length > 0
			? `${request.path}?${request.query}`
			: request.path,
		ids,
	);
	// The credentials are the state's; every other header is sent as the pact names it.
	const headers = Object.fromEntries(
		Object.entries(request.headers).filter(
			([name]) => name !== "DPoP" && name !== "Authorization",
		),
	);
	let sent: Request | undefined;
	const answer = await state.h.send(request.method, path, {
		caller: state.caller,
		dpop: state.dpop,
		body: body === undefined ? undefined : JSON.stringify(body),
		headers,
		onRequest: (seen) => {
			sent = seen;
		},
	});
	if (sent === undefined) return ["nothing was sent"];
	const carried = sent.headers;
	for (const name of ["DPoP", "Authorization"])
		if (request.headers[name] === undefined && carried.get(name) !== null)
			problems.push(`request carries ${name}, which the pact does not`);
	for (const [name, value] of Object.entries(request.headers)) {
		const mismatch = headerMismatch(
			name,
			value,
			carried.get(name),
			request.rules,
		);
		if (mismatch !== undefined) problems.push(`request ${mismatch}`);
	}

	if (answer.status !== response.status)
		problems.push(
			`status ${answer.status}, not ${response.status}: ${answer.text.slice(0, 300)}`,
		);
	for (const [name, value] of Object.entries(response.headers)) {
		const mismatch = headerMismatch(
			name,
			value,
			answer.headers.get(name),
			response.rules,
		);
		if (mismatch !== undefined) problems.push(`response ${mismatch}`);
	}
	if (response.body !== undefined) {
		const actual = parseJson(answer.text);
		const mismatch = bodyMismatch(response.body, actual, response.rules);
		if (mismatch !== undefined)
			problems.push(`response ${mismatch}: ${answer.text.slice(0, 300)}`);
	}
	return problems;
}

describe("fleet-authority.pact.json against the real service (provider)", () => {
	it("names this provider, and has a provider state for every interaction", () => {
		expect(PACT.provider).toBe("@hobo/fleet-authority HTTP API");
		expect(PACT.interactions.length).toBeGreaterThan(0);
		expect(
			PACT.interactions
				.map((interaction) => interaction.providerState)
				.filter((state) => !STATES.has(state)),
		).toEqual([]);
	});

	for (const interaction of PACT.interactions)
		it(`${interaction.request.method} ${interaction.request.path}: ${interaction.description}`, async () => {
			expect(await replay(interaction)).toEqual([]);
		}, 30_000);
});
