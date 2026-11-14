/**
 * The service under test: the authority composed by `assembleAuthority` over
 * `createTestAuthority`'s bus and event store, served by
 * `createAuthorityHandler` with no network. Credentials for every caller kind
 * of O28 are minted here.
 */
import { createHash, randomBytes } from "node:crypto";
import { create, toBinary, toJson, toJsonString } from "@bufbuild/protobuf";
import {
	allowDecision,
	createMeteringBus,
	denyDecision,
	type PolicyEngine,
	type PrincipalRef,
	parseTenantId,
} from "@hobo/core";
import {
	ApprovalMode,
	type AuthorityDeps,
	CoordinationMode,
	CredentialRequestSchema,
	DeviceClass,
	type DeviceKeys,
	EnrollmentRequestSchema,
	FleetPolicySchema,
	FleetRecordSchema,
	KEY_BUNDLE_CONTEXT,
	KeyAlgorithm,
	KeyBundleSchema,
	KeyPurpose,
	MemberKind,
	PlatformSchema,
	type PublicJwk,
	PublicKeyRefSchema,
	Role,
	type Signer,
	type SignInProvider,
	TokenCreateRequestSchema,
} from "@hobo/fleet";
import {
	createMemoryCredentialIssuer,
	createMemoryKeyStore,
	generateDpopKey,
	jwkThumbprint,
	mintDpopProof,
	parsePublicJwk,
	signEnvelope,
} from "@hobo/fleet/keys";
import { createTestAuthority } from "@hobo/fleet/testing";
import { assembleAuthority } from "../../src/compose/assemble.js";
import { createPolicyDecisionRecorder } from "../../src/identity/decisions.js";
import { createStaticPrincipalDirectory } from "../../src/identity/directory.js";
import { createAuthorityHandler } from "../../src/service/http.js";

// SAFETY-free: the test authority's issuer (createTestAuthority's trust record names it).
export const ISSUER = "https://authority.fleet.test";
export const START_MS = Date.parse("2026-11-13T10:00:00.000Z");
export const ACCOUNT_CREDENTIAL = "account-credential-of-the-relay";
export const WORKLOAD_TOKEN = "workload-oidc-token-of-a-workflow";

export type Clock = { now(): number; advance(ms: number): void };

function clock(): Clock {
	let at = START_MS;
	return {
		now: () => at,
		advance(ms) {
			at += ms;
		},
	};
}

/** Allow when the subject carries `fleet-admin` or a tag equal to the action (createTestAuthority's rule). */
function allowByTag(): PolicyEngine {
	const engineId = "fleet-authority-test";
	return {
		engineId,
		async evaluate(request) {
			const tags = request.subject.tags;
			// A device sponsors backends when it holds a role in the fleet (§6.5 "Sponsors").
			const sponsor =
				request.action === "fleet.member.declare" &&
				tags.some((tag) => tag.startsWith("role:"));
			return sponsor ||
				tags.includes("fleet-admin") ||
				tags.includes(request.action)
				? allowDecision(engineId, request, ["tag"])
				: denyDecision(engineId, request, ["no tag"]);
		},
	};
}

function testProvider(): SignInProvider {
	return {
		id: "test",
		async begin(input) {
			return {
				url: `https://idp.test/authorize?state=${encodeURIComponent(input.state)}`,
			};
		},
		async complete(input) {
			const [kind, id] = input.code.split(":");
			if (
				(kind === "user" || kind === "service") &&
				id !== undefined &&
				id.length > 0
			)
				return { ok: true, value: { principal: { kind, id }, claims: {} } };
			return {
				ok: false,
				error: { code: "unauthenticated", message: "unknown code" },
			};
		},
	};
}

export type Caller = Readonly<{
	authorization: string;
	dpopKey: Readonly<{ signer: Signer; publicJwk: PublicJwk }> | undefined;
	token: string;
}>;

export async function createHarness(
	options: Readonly<{
		/** Overlay minters for enrollment (none by default). */
		overlayMinters?: AuthorityDeps["overlayMinters"];
		/** Bus and relay URLs for discovery (none by default). */
		natsUrls?: readonly string[];
		relayUrls?: readonly string[];
	}> = {},
) {
	const time = clock();
	const now = () => time.now();
	const test = await createTestAuthority(now);
	const tenant = parseTenantId("test");
	const issuer = createMemoryCredentialIssuer(now);
	const deps: AuthorityDeps = {
		tenant,
		store: test.store,
		bus: test.bus,
		policy: allowByTag(),
		decisions: createPolicyDecisionRecorder(),
		issuer,
		directory: createStaticPrincipalDirectory([
			{
				principal: "user:alice",
				tenant: "test",
				tags: ["fleet-admin", "auditor"],
			},
			{ principal: "user:bob", tenant: "test", tags: ["fleet-admin"] },
		]),
		accounts: {
			async verify(bearer) {
				return bearer === ACCOUNT_CREDENTIAL
					? {
							ok: true,
							value: {
								principal: { kind: "service", id: "ci-relay" },
								tenant,
								scopes: ["fleet.read", "fleet.work.submit"],
							},
						}
					: {
							ok: false,
							error: { code: "unauthenticated", message: "unknown account" },
						};
			},
		},
		signIn: [testProvider()],
		assertions: {
			async verifyOidc(assertion) {
				return assertion === WORKLOAD_TOKEN
					? {
							ok: true,
							value: {
								issuer: "https://token.actions.githubusercontent.com",
								subject: "repo:acme/app:ref:refs/heads/main",
								tokenId: "jti-1",
								claims: {
									repository: "acme/app",
									exp: String(Math.floor(now() / 1000) + 300),
								},
							},
						}
					: {
							ok: false,
							error: {
								code: "unauthenticated",
								message: "not a workload token",
							},
						};
			},
			verifyCertificateChain: () => ({
				ok: false,
				error: { code: "unauthenticated", message: "no roots" },
			}),
		},
		recordSigner: generateDpopKey().signer,
		metering: createMeteringBus(),
		overlayMinters: options.overlayMinters ?? [],
		incarnation: 1,
		now,
		log: () => {},
		discovery: {
			issuer: ISSUER,
			natsUrls: options.natsUrls ?? [],
			natsSentinelCredentials: "",
			relayUrls: options.relayUrls ?? [],
			minAgentVersion: "0.0.0",
		},
	};
	const runtime = assembleAuthority(deps, { timers: false });
	runtime.start();
	await runtime.tickOnce();
	const handler = createAuthorityHandler({
		runtime,
		issuer: ISSUER,
		sessionKey: new Uint8Array(32).fill(7),
		credentials: issuer,
		store: test.store,
		registry: () => test.bus.registry,
		replay: test.bus.replay,
		now,
		log: () => {},
	});

	type Send = Readonly<{
		caller?: Caller | undefined;
		body?: string | undefined;
		headers?: Readonly<Record<string, string>>;
		dpop?: Readonly<{ signer: Signer; publicJwk: PublicJwk }> | undefined;
		/** Sees each request exactly as the handler receives it (the PACT replay checks its headers). */
		onRequest?: (request: Request) => void;
	}>;
	type Proof = Parameters<typeof mintDpopProof>[2];
	const send = async (method: string, path: string, options: Send = {}) => {
		const headers = new Headers(options.headers);
		const pathname = path.split("?")[0] ?? path;
		const key = options.dpop ?? options.caller?.dpopKey;
		if (options.caller !== undefined && options.caller.authorization.length > 0)
			headers.set("authorization", options.caller.authorization);
		if (key !== undefined) {
			const proof: Proof =
				options.caller !== undefined && options.caller.token.length > 0
					? {
							htm: method,
							htu: `${ISSUER}${pathname}`,
							nowMs: now(),
							accessToken: options.caller.token,
						}
					: { htm: method, htu: `${ISSUER}${pathname}`, nowMs: now() };
			headers.set(
				"dpop",
				await mintDpopProof(key.signer, key.publicJwk, proof),
			);
		}
		if (options.body !== undefined && !headers.has("content-type"))
			headers.set("content-type", "application/json");
		const init: RequestInit = { method, headers, redirect: "manual" };
		if (options.body !== undefined) init.body = options.body;
		const request = new Request(`${ISSUER}${path}`, init);
		options.onRequest?.(request.clone());
		const response = await handler(request);
		const text = await response.text();
		return {
			status: response.status,
			headers: response.headers,
			text,
			json: () => JSON.parse(text),
		};
	};

	const personCaller = async (
		principal: PrincipalRef,
		tags: readonly string[],
	): Promise<Caller> => {
		const key = generateDpopKey();
		const issued = await issuer.issuePerson({
			principal,
			tenant,
			tags,
			jkt: jwkThumbprint(key.publicJwk),
			ttlMs: 15 * 60_000,
		});
		return {
			authorization: `DPoP ${issued.token}`,
			dpopKey: key,
			token: issued.token,
		};
	};

	/** One sign-in through the routes up to the person's decision; `complete` or `poll` finishes it. */
	const startSignIn = async (
		code: string,
		deviceFlow = false,
		key: Readonly<{ signer: Signer; publicJwk: PublicJwk }> = generateDpopKey(),
	) => {
		const verifier = randomBytes(32).toString("base64url");
		const started = await send("POST", "/v1/fleet/signin/start", {
			body: JSON.stringify({
				provider: "test",
				tenant: "test",
				redirectUri: deviceFlow ? "" : "http://127.0.0.1:5555/callback",
				codeChallenge: createHash("sha256")
					.update(verifier)
					.digest("base64url"),
				dpopThumbprint: jwkThumbprint(key.publicJwk),
				deviceFlow,
				hostName: "ci-box",
				deviceName: "Build box",
				platform: { os: "linux", arch: "arm64" },
			}),
		});
		if (started.status !== 200) throw new Error(started.text);
		const challenge = started.json();
		const state: string = challenge.state;
		const callback = async () => {
			const answer = await send(
				"GET",
				`/v1/fleet/signin/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
			);
			const cookie =
				(answer.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
			return { answer, cookie };
		};
		const decide = async (cookie: string, approve = true) => {
			const answer = await send(
				"POST",
				`/v1/fleet/approve/${encodeURIComponent(state)}`,
				{
					body: JSON.stringify({ approve }),
					headers: { cookie },
				},
			);
			if (answer.status !== 200) throw new Error(answer.text);
			const redirect: string = answer.json().redirectUri ?? "";
			return redirect.length > 0
				? (new URL(redirect).searchParams.get("code") ?? "")
				: "";
		};
		const complete = (authorityCode: string, dpop = key) =>
			send("POST", "/v1/fleet/signin/complete", {
				body: JSON.stringify({
					state,
					code: authorityCode,
					codeVerifier: verifier,
				}),
				dpop,
			});
		const poll = (dpop = key) =>
			send("POST", "/v1/fleet/signin/device/poll", {
				body: JSON.stringify({ state }),
				dpop,
			});
		return {
			key,
			verifier,
			state,
			challenge,
			callback,
			decide,
			complete,
			poll,
		};
	};

	/** A person signed in through the browser flow, as a caller. */
	const signedIn = async (code: string): Promise<Caller> => {
		const flow = await startSignIn(code);
		const { cookie } = await flow.callback();
		const authorityCode = await flow.decide(cookie);
		const answer = await flow.complete(authorityCode);
		if (answer.status !== 200) throw new Error(answer.text);
		const token: string = answer.json().token;
		return { authorization: `DPoP ${token}`, dpopKey: flow.key, token };
	};

	return {
		time,
		now,
		deps,
		runtime,
		handler,
		send,
		test,
		issuer,
		tenant,
		personCaller,
		startSignIn,
		signedIn,
	};
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export function fleetBody(
	id: string,
	approval = ApprovalMode.AUTO_OWNER,
): string {
	return toJsonString(
		FleetRecordSchema,
		create(FleetRecordSchema, {
			fleetId: id,
			coordination: CoordinationMode.MANY_ACTIVE,
			policy: create(FleetPolicySchema, {
				approval,
				allowedKinds: [MemberKind.DEVICE],
				allowedRoles: [Role.EXECUTOR, Role.DISPATCHER],
			}),
		}),
	);
}

export async function newDevice(nowMs: number) {
	const keys: DeviceKeys = await createMemoryKeyStore().open();
	const identity = parsePublicJwk(keys.identityJwk);
	if (!identity.ok) throw new Error(identity.error.message);
	const signJwk: PublicJwk = {
		kty: "OKP",
		crv: "Ed25519",
		x: keys.signPublicKey,
	};
	const bundle = await signEnvelope(
		keys.identity,
		KEY_BUNDLE_CONTEXT,
		toBinary(
			KeyBundleSchema,
			create(KeyBundleSchema, {
				memberId: keys.memberId,
				sequence: 1,
				keys: [
					create(PublicKeyRefSchema, {
						purpose: KeyPurpose.SIGN,
						keyId: keys.sign.keyId,
						algorithm: KeyAlgorithm.EDDSA,
						value: keys.signPublicKey,
					}),
					create(PublicKeyRefSchema, {
						purpose: KeyPurpose.SEAL,
						keyId: `${keys.memberId}#seal`,
						algorithm: KeyAlgorithm.UNSPECIFIED,
						value: keys.sealPublicKey,
					}),
				],
				issuedAt: new Date(nowMs).toISOString(),
				notAfter: new Date(nowMs + 24 * 3_600_000).toISOString(),
			}),
		),
	);
	return {
		keys,
		identityKey: { signer: keys.identity, publicJwk: identity.value },
		signKey: { signer: keys.sign, publicJwk: signJwk },
		bundle,
	};
}

export type Device = Awaited<ReturnType<typeof newDevice>>;

export function enrollmentBody(
	device: Device,
	fleet: string,
	proof: Readonly<{ bootstrapToken?: string; personToken?: string }>,
	name = `box-${device.keys.memberId.slice(-6)}`,
): string {
	return toJsonString(
		EnrollmentRequestSchema,
		create(EnrollmentRequestSchema, {
			tenant: "test",
			fleet,
			name,
			displayName: "Box",
			identityJwk: device.keys.identityJwk,
			keyBundle: device.bundle,
			platform: create(PlatformSchema, { os: "linux", arch: "x64" }),
			region: "eu-west-1",
			agentVersion: "1.2.0",
			deviceClass: DeviceClass.DEDICATED,
			requestedRoles: [Role.EXECUTOR, Role.DISPATCHER],
			proof:
				proof.bootstrapToken !== undefined
					? { case: "bootstrapToken", value: proof.bootstrapToken }
					: { case: "personToken", value: proof.personToken ?? "" },
		}),
	);
}

export function tokenBody(fleet: string, name: string): string {
	return toJsonString(
		TokenCreateRequestSchema,
		create(TokenCreateRequestSchema, {
			fleet,
			name,
			displayName: name,
			deviceClass: DeviceClass.DEDICATED,
			roles: [Role.EXECUTOR, Role.DISPATCHER],
			ttlSeconds: 900,
		}),
	);
}

export function credentialBody(generation: number): string {
	return JSON.stringify(
		toJson(
			CredentialRequestSchema,
			create(CredentialRequestSchema, {
				generation,
				refreshNonce: new Uint8Array(16).fill(generation + 1),
				agentVersion: "1.2.0",
			}),
		),
	);
}
