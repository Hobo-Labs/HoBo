// O29: sign-in is single use, loopback only and key-bound (design §6.5, §10.1).
import { createHash, randomBytes } from "node:crypto";
import { create, toBinary } from "@bufbuild/protobuf";
import { type PrincipalRef, parseTenantId } from "@hobo/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
	PlatformSchema,
	type SignInStart,
	SignInStartSchema,
	TrustRecordSchema,
	WitnessedEnvelopeSchema,
} from "../../src/_generated/fleet_pb.js";
import { TRUST_RECORD_CONTEXT } from "../../src/contexts.js";
import {
	createMemoryCredentialIssuer,
	fingerprintWords,
	generateDpopKey,
	jwkThumbprint,
	mintDpopProof,
	signEnvelope,
} from "../../src/keys/index.js";
import type {
	AuthorityBus,
	CredentialIssuer,
	FleetEventStore,
	Outcome,
	PrincipalDirectory,
	PublicJwk,
	Signer,
	SignInProvider,
	VerifiedToken,
} from "../../src/ports.js";
import { createSignIn } from "../../src/signin/index.js";
import {
	createMemoryBus,
	createMemoryEventStore,
} from "../../src/testing/plumbing/index.js";

const ISSUER = "https://authority.fleet.test";
const COMPLETE_URL = `${ISSUER}/v1/fleet/signin/complete`;
const POLL_URL = `${ISSUER}/v1/fleet/signin/device/poll`;
const REFRESH_URL = `${ISSUER}/v1/fleet/signin/refresh`;
const LOOPBACK = "http://127.0.0.1:53682/callback";
const START_MS = Date.parse("2026-11-13T10:00:00.000Z");
const tenant = parseTenantId("test");
const alice: PrincipalRef = { kind: "user", id: "alice" };

type Key = Readonly<{ signer: Signer; publicJwk: PublicJwk; jkt: string }>;
type World = Readonly<{
	store: FleetEventStore;
	bus: AuthorityBus;
	issuer: CredentialIssuer;
	people: Map<string, readonly string[]>;
	clock: { ms: number };
	signIn(): ReturnType<typeof createSignIn>;
}>;

function newKey(): Key {
	const { signer, publicJwk } = generateDpopKey();
	return { signer, publicJwk, jkt: jwkThumbprint(publicJwk) };
}

function verifierAndChallenge() {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

function testProvider(people: ReadonlyMap<string, readonly string[]>) {
	const begun: { state: string; redirectUri: string }[] = [];
	const provider: SignInProvider = {
		id: "test",
		async begin(input) {
			begun.push({ state: input.state, redirectUri: input.redirectUri });
			return {
				url: `https://idp.test/authorize?state=${encodeURIComponent(input.state)}&code_challenge=${input.codeChallenge}`,
			};
		},
		async complete(input) {
			const [kind, id] = input.code.split(":");
			if (kind !== "user" || id === undefined || !people.has(`user:${id}`))
				return {
					ok: false,
					error: { code: "unauthenticated", message: "unknown principal" },
				};
			return {
				ok: true,
				value: { principal: { kind: "user", id }, claims: {} },
			};
		},
	};
	return { provider, begun };
}

function testDirectory(
	people: ReadonlyMap<string, readonly string[]>,
	noTenant: ReadonlySet<string>,
): PrincipalDirectory {
	return {
		async tenantsOf(principal) {
			const key = `${principal.kind}:${principal.id}`;
			const tags = people.get(key);
			if (tags === undefined || noTenant.has(key)) return [];
			return [{ tenant, tags, aliases: [] }];
		},
	};
}

async function world(
	noTenant: ReadonlySet<string> = new Set(),
): Promise<World & { begun: { state: string; redirectUri: string }[] }> {
	const clock = { ms: START_MS };
	const now = () => clock.ms;
	const store = createMemoryEventStore();
	const bus = createMemoryBus(now);
	const witness = newKey();
	const payload = toBinary(
		TrustRecordSchema,
		create(TrustRecordSchema, {
			tenant,
			sequence: 1,
			issuer: ISSUER,
			jwksUri: `${ISSUER}/v1/fleet/jwks`,
			issuedAt: new Date(START_MS).toISOString(),
		}),
	);
	await bus.publisher.putTrust(
		create(WitnessedEnvelopeSchema, {
			authority: await signEnvelope(
				witness.signer,
				TRUST_RECORD_CONTEXT,
				payload,
			),
			witness: await signEnvelope(
				witness.signer,
				TRUST_RECORD_CONTEXT,
				payload,
			),
		}),
	);
	const issuer = createMemoryCredentialIssuer(now);
	const people = new Map<string, readonly string[]>([
		["user:alice", ["fleet-admin"]],
		["user:bob", []],
	]);
	const { provider, begun } = testProvider(people);
	const directory = testDirectory(people, noTenant);
	return {
		store,
		bus,
		issuer,
		people,
		clock,
		begun,
		signIn: () =>
			createSignIn({
				tenant,
				store,
				bus,
				issuer,
				directory,
				signIn: [provider],
				now,
				log: () => {},
			}),
	};
}

function startRequest(
	key: Key,
	challenge: string,
	overrides: Partial<SignInStart> = {},
): SignInStart {
	return create(SignInStartSchema, {
		provider: "test",
		tenant: "test",
		redirectUri: LOOPBACK,
		codeChallenge: challenge,
		dpopThumbprint: key.jkt,
		deviceFlow: false,
		hostName: "laptop",
		deviceName: "build-box",
		platform: create(PlatformSchema, { os: "linux", arch: "x64" }),
		...overrides,
	});
}

function proof(w: World, key: Key, htu: string): Promise<string> {
	return mintDpopProof(key.signer, key.publicJwk, {
		htm: "POST",
		htu,
		nowMs: w.clock.ms,
	});
}

function value<T>(outcome: Outcome<T>): T {
	if (!outcome.ok)
		throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
	return outcome.value;
}

function code<T>(outcome: Outcome<T>): string {
	return outcome.ok ? "ok" : outcome.error.code;
}

/** Runs the browser flow up to the person's confirmation; returns the loopback code. */
async function browserToApproval(
	w: World,
	key: Key,
	challenge: string,
): Promise<Readonly<{ state: string; authorityCode: string }>> {
	const signIn = w.signIn();
	const started = value(await signIn.start(startRequest(key, challenge)));
	value(
		await signIn.callback({
			$typeName: "hobo.fleet.v1.SignInCallback",
			state: started.state,
			code: "user:alice",
			error: "",
		}),
	);
	const result = value(
		await signIn.approve({
			$typeName: "hobo.fleet.v1.ApprovalDecision",
			state: started.state,
			approve: true,
		}),
	);
	const redirect = new URL(result.redirectUri);
	return {
		state: started.state,
		authorityCode: redirect.searchParams.get("code") ?? "",
	};
}

function callback(state: string, providerCode: string) {
	return {
		$typeName: "hobo.fleet.v1.SignInCallback" as const,
		state,
		code: providerCode,
		error: "",
	};
}

function complete(state: string, authorityCode: string, verifier: string) {
	return {
		$typeName: "hobo.fleet.v1.SignInComplete" as const,
		state,
		code: authorityCode,
		codeVerifier: verifier,
	};
}

describe("createSignIn: the browser flow", () => {
	let w: Awaited<ReturnType<typeof world>>;
	beforeEach(async () => {
		w = await world();
	});

	it("starts with the provider's authorize URL and the authority's callback", async () => {
		const key = newKey();
		const { challenge } = verifierAndChallenge();
		const started = value(await w.signIn().start(startRequest(key, challenge)));
		expect(started.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
		expect(started.authorizeUrl).toMatch(/^https:\/\/idp\.test\/authorize/u);
		expect(started.userCode).toBe("");
		expect(Date.parse(started.expiresAt)).toBeGreaterThan(START_MS);
		expect(w.begun).toEqual([
			{
				state: started.state,
				redirectUri: `${ISSUER}/v1/fleet/signin/callback`,
			},
		]);
		// The authority runs its own PKCE with the provider; the CLI's challenge never leaves it.
		expect(started.authorizeUrl).not.toContain(challenge);
	});

	it("shows an ApprovalView with the four fingerprint words of the sign-in key", async () => {
		const key = newKey();
		const { challenge } = verifierAndChallenge();
		const signIn = w.signIn();
		const started = value(await signIn.start(startRequest(key, challenge)));
		const view = value(
			await signIn.callback(callback(started.state, "user:alice")),
		);
		expect(view.fingerprintWords).toEqual([...fingerprintWords(key.jkt)]);
		expect(view.fingerprintWords).toHaveLength(4);
		expect(view.principal).toBe("user:alice");
		expect(view.hostName).toBe("laptop");
		expect(view.deviceName).toBe("build-box");
		expect(view.platform?.os).toBe("linux");
		expect(view.deviceFlow).toBe(false);
		expect(view.state).toBe(started.state);
		const again = value(await signIn.approval(started.state));
		expect(again.fingerprintWords).toEqual(view.fingerprintWords);
	});

	it("issues a person token bound to the caller's DPoP key, with a 12-hour refresh", async () => {
		const key = newKey();
		const { verifier, challenge } = verifierAndChallenge();
		const { state, authorityCode } = await browserToApproval(w, key, challenge);
		expect(authorityCode.length).toBeGreaterThan(20);
		const credential = value(
			await w
				.signIn()
				.complete(
					complete(state, authorityCode, verifier),
					await proof(w, key, COMPLETE_URL),
				),
		);
		expect(credential.principal).toBe("user:alice");
		expect(credential.tenant).toBe("test");
		expect(credential.tags).toEqual(["fleet-admin"]);
		expect(Date.parse(credential.expiresAt)).toBe(START_MS + 15 * 60_000);
		expect(Date.parse(credential.refreshUntil)).toBe(START_MS + 12 * 3_600_000);
		const verified = value(
			w.issuer.verify(credential.token, ISSUER, w.clock.ms),
		);
		expect(verified.kind).toBe("person");
		if (verified.kind === "person") {
			expect(verified.jkt).toBe(key.jkt);
			expect(verified.principal).toEqual(alice);
		}
	});

	it("refuses a DPoP proof made with any key other than the sign-in key", async () => {
		const key = newKey();
		const other = newKey();
		const { verifier, challenge } = verifierAndChallenge();
		const { state, authorityCode } = await browserToApproval(w, key, challenge);
		const outcome = await w
			.signIn()
			.complete(
				complete(state, authorityCode, verifier),
				await proof(w, other, COMPLETE_URL),
			);
		expect(code(outcome)).toBe("proof-invalid");
		// The refusal does not consume the code: the right key still completes.
		const retried = await w
			.signIn()
			.complete(
				complete(state, authorityCode, verifier),
				await proof(w, key, COMPLETE_URL),
			);
		expect(code(retried)).toBe("ok");
	});

	it("refuses a wrong PKCE verifier and a wrong authority code", async () => {
		const key = newKey();
		const { verifier, challenge } = verifierAndChallenge();
		const { state, authorityCode } = await browserToApproval(w, key, challenge);
		const wrongVerifier = await w
			.signIn()
			.complete(
				complete(state, authorityCode, verifierAndChallenge().verifier),
				await proof(w, key, COMPLETE_URL),
			);
		expect(code(wrongVerifier)).toBe("unauthenticated");
		const wrongCode = await w
			.signIn()
			.complete(
				complete(state, randomBytes(32).toString("base64url"), verifier),
				await proof(w, key, COMPLETE_URL),
			);
		expect(code(wrongCode)).toBe("unauthenticated");
	});

	it("refuses a proof for another route or a replayed proof", async () => {
		const key = newKey();
		const { verifier, challenge } = verifierAndChallenge();
		const { state, authorityCode } = await browserToApproval(w, key, challenge);
		const wrongRoute = await w
			.signIn()
			.complete(
				complete(state, authorityCode, verifier),
				await proof(w, key, POLL_URL),
			);
		expect(code(wrongRoute)).toBe("proof-invalid");
		const dpop = await proof(w, key, COMPLETE_URL);
		const signIn = w.signIn();
		const outcome = await signIn.complete(
			complete(state, randomBytes(32).toString("base64url"), verifier),
			dpop,
		);
		expect(code(outcome)).toBe("unauthenticated");
		const replayed = await signIn.complete(
			complete(state, authorityCode, verifier),
			dpop,
		);
		expect(code(replayed)).toBe("proof-replayed");
	});

	it("redirects with an error and never issues when the person declines", async () => {
		const key = newKey();
		const { verifier, challenge } = verifierAndChallenge();
		const signIn = w.signIn();
		const started = value(await signIn.start(startRequest(key, challenge)));
		value(await signIn.callback(callback(started.state, "user:alice")));
		const result = value(
			await signIn.approve({
				$typeName: "hobo.fleet.v1.ApprovalDecision",
				state: started.state,
				approve: false,
			}),
		);
		const redirect = new URL(result.redirectUri);
		expect(redirect.searchParams.get("error")).toBe("access_denied");
		expect(redirect.searchParams.get("code")).toBeNull();
		const outcome = await signIn.complete(
			complete(started.state, "anything", verifier),
			await proof(w, key, COMPLETE_URL),
		);
		expect(code(outcome)).toBe("forbidden");
	});

	it("refuses a provider error, an unknown principal and an unknown state", async () => {
		const key = newKey();
		const { challenge } = verifierAndChallenge();
		const signIn = w.signIn();
		const started = value(await signIn.start(startRequest(key, challenge)));
		const providerError = await signIn.callback({
			$typeName: "hobo.fleet.v1.SignInCallback",
			state: started.state,
			code: "",
			error: "access_denied",
		});
		expect(code(providerError)).toBe("unauthenticated");
		const unknown = await signIn.callback(
			callback(started.state, "user:mallory"),
		);
		expect(code(unknown)).toBe("unauthenticated");
		const noState = await signIn.callback(
			callback(randomBytes(32).toString("base64url"), "user:alice"),
		);
		expect(code(noState)).toBe("unauthenticated");
		expect(code(await signIn.approval(started.state))).toBe("conflict");
	});

	it("refuses every step once the sign-in has expired", async () => {
		const key = newKey();
		const { challenge } = verifierAndChallenge();
		const signIn = w.signIn();
		const started = value(await signIn.start(startRequest(key, challenge)));
		w.clock.ms = Date.parse(started.expiresAt) + 1;
		const outcome = await signIn.callback(
			callback(started.state, "user:alice"),
		);
		expect(code(outcome)).toBe("unauthenticated");
	});
});

describe("createSignIn: a principal with no tenant", () => {
	it("is forbidden at the callback", async () => {
		const w = await world(new Set(["user:bob"]));
		const key = newKey();
		const { challenge } = verifierAndChallenge();
		const signIn = w.signIn();
		const started = value(await signIn.start(startRequest(key, challenge)));
		const outcome = await signIn.callback(callback(started.state, "user:bob"));
		expect(code(outcome)).toBe("forbidden");
		expect(code(await signIn.approval(started.state))).toBe("conflict");
	});
});

describe("createSignIn: loopback redirects only", () => {
	const refused = [
		"https://evil.example/callback",
		"http://localhost:53682/callback",
		"http://127.0.0.1.evil.example:80/callback",
		"http://127.0.0.1/callback",
		"http://[::2]:53682/callback",
		"http://127.0.0.1:99999/callback",
		"http://user@127.0.0.1:53682/callback",
		"http://127.0.0.1:53682/callback#fragment",
		"",
	];
	for (const redirectUri of refused) {
		it(`refuses ${JSON.stringify(redirectUri)}`, async () => {
			const w = await world();
			const outcome = await w.signIn().start(
				startRequest(newKey(), verifierAndChallenge().challenge, {
					redirectUri,
				}),
			);
			expect(code(outcome)).toBe("invalid-request");
			expect(w.begun).toEqual([]);
		});
	}

	for (const redirectUri of [
		"http://127.0.0.1:53682/callback",
		"http://[::1]:8080/",
	]) {
		it(`accepts ${redirectUri}`, async () => {
			const w = await world();
			const outcome = await w.signIn().start(
				startRequest(newKey(), verifierAndChallenge().challenge, {
					redirectUri,
				}),
			);
			expect(code(outcome)).toBe("ok");
		});
	}

	it("refuses a redirect on the device flow, an unknown provider, another tenant and a bad thumbprint", async () => {
		const w = await world();
		const { challenge } = verifierAndChallenge();
		const cases: Partial<SignInStart>[] = [
			{ deviceFlow: true },
			{ provider: "github" },
			{ tenant: "other" },
			{ dpopThumbprint: "short" },
			{ codeChallenge: "" },
		];
		for (const overrides of cases) {
			const outcome = await w
				.signIn()
				.start(startRequest(newKey(), challenge, overrides));
			expect(code(outcome), JSON.stringify(overrides)).toBe("invalid-request");
		}
	});
});

describe("createSignIn: each step is used once across two instances on one store", () => {
	it("lets exactly one instance take each step", async () => {
		const w = await world();
		const a = w.signIn();
		const b = w.signIn();
		const key = newKey();
		const { verifier, challenge } = verifierAndChallenge();
		const started = value(await a.start(startRequest(key, challenge)));

		const callbacks = await Promise.all([
			a.callback(callback(started.state, "user:alice")),
			b.callback(callback(started.state, "user:alice")),
		]);
		expect(callbacks.map(code).sort()).toEqual(["conflict", "ok"]);
		expect(code(await a.callback(callback(started.state, "user:alice")))).toBe(
			"conflict",
		);

		const decision = {
			$typeName: "hobo.fleet.v1.ApprovalDecision" as const,
			state: started.state,
			approve: true,
		};
		const approvals = await Promise.all([
			a.approve(decision),
			b.approve(decision),
		]);
		expect(approvals.map(code).sort()).toEqual(["conflict", "ok"]);
		const approved = approvals.find((outcome) => outcome.ok);
		const authorityCode =
			approved?.ok === true
				? (new URL(approved.value.redirectUri).searchParams.get("code") ?? "")
				: "";

		const completions = await Promise.all([
			a.complete(
				complete(started.state, authorityCode, verifier),
				await proof(w, key, COMPLETE_URL),
			),
			b.complete(
				complete(started.state, authorityCode, verifier),
				await proof(w, key, COMPLETE_URL),
			),
		]);
		expect(completions.map(code).sort()).toEqual(["conflict", "ok"]);
		const later = await b.complete(
			complete(started.state, authorityCode, verifier),
			await proof(w, key, COMPLETE_URL),
		);
		expect(code(later)).toBe("conflict");
	});
});

describe("createSignIn: the device-code flow", () => {
	const poll = (state: string) => ({
		$typeName: "hobo.fleet.v1.SignInPoll" as const,
		state,
	});

	it("answers sign-in-pending until approved, then the credential once", async () => {
		const w = await world();
		const key = newKey();
		const { challenge } = verifierAndChallenge();
		const cli = w.signIn();
		const browser = w.signIn();
		const started = value(
			await cli.start(
				startRequest(key, challenge, { deviceFlow: true, redirectUri: "" }),
			),
		);
		expect(started.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/u);
		expect(started.verificationUrl).toBe(`${ISSUER}/v1/fleet/signin/device`);
		expect(started.authorizeUrl).toBe("");
		expect(started.intervalSeconds).toBeGreaterThan(0);
		expect(w.begun).toEqual([]);

		expect(
			code(await cli.poll(poll(started.state), await proof(w, key, POLL_URL))),
		).toBe("sign-in-pending");

		const entered = value(
			await browser.device({
				$typeName: "hobo.fleet.v1.SignInDeviceCode",
				userCode: started.userCode,
			}),
		);
		expect(entered.authorizeUrl).toMatch(/^https:\/\/idp\.test\/authorize/u);
		expect(entered.state).toBe(started.state);

		const view = value(
			await browser.callback(callback(started.state, "user:alice")),
		);
		expect(view.deviceFlow).toBe(true);
		expect(view.fingerprintWords).toEqual([...fingerprintWords(key.jkt)]);
		expect(
			code(await cli.poll(poll(started.state), await proof(w, key, POLL_URL))),
		).toBe("sign-in-pending");

		const result = value(
			await browser.approve({
				$typeName: "hobo.fleet.v1.ApprovalDecision",
				state: started.state,
				approve: true,
			}),
		);
		expect(result.redirectUri).toBe("");

		const other = newKey();
		expect(
			code(
				await cli.poll(poll(started.state), await proof(w, other, POLL_URL)),
			),
		).toBe("proof-invalid");

		const credential = value(
			await cli.poll(poll(started.state), await proof(w, key, POLL_URL)),
		);
		const verified = value(
			w.issuer.verify(credential.token, ISSUER, w.clock.ms),
		);
		expect(verified.kind === "person" && verified.jkt).toBe(key.jkt);

		expect(
			code(await cli.poll(poll(started.state), await proof(w, key, POLL_URL))),
		).toBe("conflict");
	});

	it("accepts a typed code in lower case or with a dash, and refuses an unknown code", async () => {
		const w = await world();
		const key = newKey();
		const started = value(
			await w.signIn().start(
				startRequest(key, verifierAndChallenge().challenge, {
					deviceFlow: true,
					redirectUri: "",
				}),
			),
		);
		const typed =
			`${started.userCode.slice(0, 4)}-${started.userCode.slice(4)}`.toLowerCase();
		const entered = await w.signIn().device({
			$typeName: "hobo.fleet.v1.SignInDeviceCode",
			userCode: typed,
		});
		expect(code(entered)).toBe("ok");
		const unknown = await w.signIn().device({
			$typeName: "hobo.fleet.v1.SignInDeviceCode",
			userCode: started.userCode === "BBBBBBBB" ? "CCCCCCCC" : "BBBBBBBB",
		});
		expect(code(unknown)).toBe("unauthenticated");
		const malformed = await w.signIn().device({
			$typeName: "hobo.fleet.v1.SignInDeviceCode",
			userCode: "AEIOU123",
		});
		expect(code(malformed)).toBe("invalid-request");
	});

	it("answers forbidden once the person declines", async () => {
		const w = await world();
		const key = newKey();
		const signIn = w.signIn();
		const started = value(
			await signIn.start(
				startRequest(key, verifierAndChallenge().challenge, {
					deviceFlow: true,
					redirectUri: "",
				}),
			),
		);
		value(
			await signIn.device({
				$typeName: "hobo.fleet.v1.SignInDeviceCode",
				userCode: started.userCode,
			}),
		);
		value(await signIn.callback(callback(started.state, "user:alice")));
		value(
			await signIn.approve({
				$typeName: "hobo.fleet.v1.ApprovalDecision",
				state: started.state,
				approve: false,
			}),
		);
		expect(
			code(
				await signIn.poll(poll(started.state), await proof(w, key, POLL_URL)),
			),
		).toBe("forbidden");
	});

	it("refuses to complete a device sign-in through the loopback exchange", async () => {
		const w = await world();
		const key = newKey();
		const { verifier, challenge } = verifierAndChallenge();
		const signIn = w.signIn();
		const started = value(
			await signIn.start(
				startRequest(key, challenge, { deviceFlow: true, redirectUri: "" }),
			),
		);
		const outcome = await signIn.complete(
			complete(started.state, "x", verifier),
			await proof(w, key, COMPLETE_URL),
		);
		expect(code(outcome)).toBe("invalid-request");
	});
});

describe("createSignIn: refresh", () => {
	async function signedIn(w: World, key: Key) {
		const { verifier, challenge } = verifierAndChallenge();
		const { state, authorityCode } = await browserToApproval(w, key, challenge);
		const credential = value(
			await w
				.signIn()
				.complete(
					complete(state, authorityCode, verifier),
					await proof(w, key, COMPLETE_URL),
				),
		);
		return value(w.issuer.verify(credential.token, ISSUER, w.clock.ms));
	}

	it("re-issues for the same key until 12 hours after sign-in", async () => {
		const w = await world();
		const key = newKey();
		let caller: VerifiedToken = await signedIn(w, key);
		for (let hour = 0; hour < 12; hour += 1) {
			w.clock.ms += 14 * 60_000;
			const credential = value(
				await w.signIn().refresh(caller, await proof(w, key, REFRESH_URL)),
			);
			expect(Date.parse(credential.refreshUntil)).toBe(
				START_MS + 12 * 3_600_000,
			);
			expect(Date.parse(credential.expiresAt)).toBeLessThanOrEqual(
				START_MS + 12 * 3_600_000,
			);
			caller = value(w.issuer.verify(credential.token, ISSUER, w.clock.ms));
			expect(caller.kind === "person" && caller.jkt).toBe(key.jkt);
		}
		w.clock.ms = START_MS + 12 * 3_600_000;
		expect(
			code(await w.signIn().refresh(caller, await proof(w, key, REFRESH_URL))),
		).toBe("unauthenticated");
	});

	it("caps the refreshed token at the end of the 12 hours", async () => {
		const w = await world();
		const key = newKey();
		const caller = await signedIn(w, key);
		w.clock.ms = START_MS + 12 * 3_600_000 - 5 * 60_000;
		const credential = value(
			await w.signIn().refresh(caller, await proof(w, key, REFRESH_URL)),
		);
		expect(Date.parse(credential.expiresAt)).toBe(START_MS + 12 * 3_600_000);
	});

	it("refuses another key, a member token and a person never signed in here", async () => {
		const w = await world();
		const key = newKey();
		const caller = await signedIn(w, key);
		const other = newKey();
		expect(
			code(
				await w.signIn().refresh(caller, await proof(w, other, REFRESH_URL)),
			),
		).toBe("proof-invalid");
		const stranger: VerifiedToken = {
			kind: "person",
			principal: { kind: "user", id: "carol" },
			tenant,
			tags: ["fleet-admin"],
			jkt: other.jkt,
			expiresAtMs: w.clock.ms + 60_000,
		};
		expect(
			code(
				await w.signIn().refresh(stranger, await proof(w, other, REFRESH_URL)),
			),
		).toBe("unauthenticated");
		const account: VerifiedToken = {
			kind: "account",
			principal: alice,
			tenant,
			scopes: [],
		};
		expect(
			code(await w.signIn().refresh(account, await proof(w, key, REFRESH_URL))),
		).toBe("unauthenticated");
	});
});

describe("createSignIn: the store", () => {
	it("records the four sign-in events and the person, never a token or code", async () => {
		const w = await world();
		const key = newKey();
		const { verifier, challenge } = verifierAndChallenge();
		const { state, authorityCode } = await browserToApproval(w, key, challenge);
		const credential = value(
			await w
				.signIn()
				.complete(
					complete(state, authorityCode, verifier),
					await proof(w, key, COMPLETE_URL),
				),
		);
		const types: string[] = [];
		const text: string[] = [];
		for await (const { event } of w.store.readAll()) {
			types.push(
				`${event.streamId.startsWith(`fleet-signin-${state}`) ? "signin" : event.streamId.split("-").slice(0, 2).join("-")} ${event.type}`,
			);
			text.push(JSON.stringify(event));
		}
		expect(types).toEqual([
			"signin fleet.SignInStarted",
			"signin fleet.SignInAuthenticated",
			"signin fleet.SignInApproved",
			"signin fleet.SignInCompleted",
			"fleet-person fleet.PersonSignedIn",
		]);
		const all = text.join("\n");
		expect(all).not.toContain(credential.token);
		expect(all).not.toContain(authorityCode);
		expect(all).not.toContain(verifier);
	});
});
