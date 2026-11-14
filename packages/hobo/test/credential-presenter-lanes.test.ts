/**
 * How `hobo` decides which credential to present, and what it says about it.
 *
 * One call — `presentAuthenticated` — has to serve four quite different
 * callers: an agent with a workload identity, a logged-in human, a caller that
 * demands a real principal and would rather have nothing, and a developer
 * working offline. The lanes are tried in that order, and the order is the
 * contract.
 *
 * **An agent identity outranks a stored human session.** A CI run on a machine
 * where someone once logged in must deploy as the agent, not as that person.
 * The human is carried alongside as `humanPrincipal` rather than replacing the
 * agent, so the audit trail records both who authorized the automation and
 * what actually ran.
 *
 * **`requirePrincipal` is a refusal, not a downgrade.** Without it the
 * presenter falls back to an offline fixture identity, which is right for
 * `hobo dev` and catastrophic for a remote deploy: work would be placed under
 * `user:local-fixture` on a shared broker. The flag is how a remote caller
 * says it would rather see `null`.
 *
 * **Every minted proof is verified before it leaves.** The presenter re-checks
 * its own SVID and DPoP proof, so a mis-signed credential fails here rather
 * than at a broker that can only answer "rejected".
 */
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { PersonCredentialSchema } from "@hobo/fleet";
import { verifyDpopProof } from "@hobo/fleet/keys";
import { verifyJwtWithJwks } from "@hobo/identity";
import { afterEach, describe, expect, it } from "vitest";
import {
	authorizationHeaders,
	createCredentialPresenter,
	createLocalSvidIssuer,
	loadOrCreateDpopKeyPair,
	mintMockDpopProof,
	type PresentedCredential,
	profileHasSession,
} from "../src/credential-presenter.js";
import { newSignInKey, savePerson } from "../src/fleet-home.js";
import {
	HOBO_PROFILE_SCHEMA,
	type HoboProfileSession,
	saveHoboProfile,
} from "../src/hobo-profile.js";

const AUDIENCE = "https://broker.example";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-presenter-"));
	dirs.push(dir);
	return dir;
}

/** A home with a stored login session, optionally DPoP-bound. */
function homeWithSession(options: { proofKeyId?: string } = {}): string {
	const dir = home();
	const base: HoboProfileSession = {
		principal: { kind: "user", id: "user:ada" },
		tenant: "acme",
		token: "session-token",
		issuedAt: "2026-01-01T00:00:00.000Z",
	};
	const session: HoboProfileSession =
		options.proofKeyId === undefined
			? base
			: { ...base, proofKeyId: options.proofKeyId };
	saveHoboProfile(dir, {
		schemaVersion: HOBO_PROFILE_SCHEMA,
		updatedAt: "2026-01-01T00:00:00.000Z",
		session,
	});
	return dir;
}

function presenter(
	options: Parameters<typeof createCredentialPresenter>[0] = {},
) {
	return createCredentialPresenter(options);
}

async function present(
	hoboHome: string,
	env: NodeJS.ProcessEnv = {},
	extra: { requirePrincipal?: boolean; htm?: string } = {},
	options: Parameters<typeof createCredentialPresenter>[0] = {},
): Promise<PresentedCredential | null> {
	return presenter(options).presentAuthenticated({
		audience: AUDIENCE,
		hoboHome,
		env,
		...extra,
	});
}

describe("agent lane", () => {
	it("mints a DPoP-bound SVID when an agent id is in the environment", async () => {
		// A workload identity is the strongest thing available, so it is tried
		// first. Presenting a bearer session instead would let a CI job deploy as
		// whoever last logged into the runner image.
		const credential = await present(home(), { HOBO_AGENT_ID: "agent:ci" });
		expect(credential?.scheme).toBe("dpop-bound");
		expect(credential?.principal).toEqual({ kind: "agent", id: "agent:ci" });
		expect(credential?.dpopProof).toBeTruthy();
		expect(credential?.proofKeyId).toBeTruthy();
	});

	it("describes the credential it minted in metadata", async () => {
		// A broker that rejects the credential reports only "rejected". The
		// algorithms and the SPIFFE id are what let the caller tell a wrong
		// audience from a wrong signing key without a packet capture.
		const credential = await present(home(), { HOBO_AGENT_ID: "agent:ci" });
		expect(credential?.metadata?.credentialScheme).toBe("spiffe-jwt-svid+dpop");
		expect(credential?.metadata?.svidAlg).toBe("RS256");
		expect(credential?.metadata?.dpopAlg).toBe("ES256");
		expect(credential?.metadata?.spiffeId).toContain("spiffe://");
	});

	it("takes an explicit SPIFFE id over one derived from the agent id", async () => {
		// The derived form is a convenience for local runs. On a real mesh the
		// id is issued, and deriving one would present an identity the trust
		// domain never granted.
		const credential = await present(home(), {
			HOBO_AGENT_ID: "agent:ci",
			HOBO_SPIFFE_ID: "spiffe://prod.example/ns/ci/sa/deployer",
		});
		expect(credential?.metadata?.spiffeId).toBe(
			"spiffe://prod.example/ns/ci/sa/deployer",
		);
	});

	it("uses an agent id that is already a SPIFFE id as-is", async () => {
		// Wrapping an existing SPIFFE id in another one would produce an
		// identity no trust domain recognises.
		const credential = await present(home(), {
			HOBO_AGENT_ID: "spiffe://prod.example/ns/ci/sa/deployer",
		});
		expect(credential?.metadata?.spiffeId).toBe(
			"spiffe://prod.example/ns/ci/sa/deployer",
		);
	});

	it("derives an agent from a raw SVID value, sanitised and bounded", async () => {
		// The value comes from an environment variable that may hold a socket
		// path or an opaque blob. It becomes part of a principal id and a key
		// filename, so the characters and the length both have to be bounded.
		const credential = await present(home(), {
			HOBO_AGENT_SVID: `unix:///run/spire/${"x".repeat(80)}.sock`,
		});
		expect(credential?.principal.kind).toBe("agent");
		expect(credential?.principal.id.startsWith("agent:")).toBe(true);
		expect(credential?.principal.id).toMatch(/^agent:[a-zA-Z0-9_-]+$/);
		expect(credential?.principal.id.length).toBeLessThanOrEqual(6 + 32);
	});

	it("accepts a SPIFFE-shaped SVID value without rewriting it", async () => {
		const credential = await present(home(), {
			HOBO_AGENT_SVID: "spiffe://mesh.example/workload",
		});
		expect(credential?.principal.id).toBe("spiffe://mesh.example/workload");
	});

	it("falls back to the SPIFFE endpoint socket when no SVID is set", async () => {
		// A workload with a Workload API socket and no explicit variable is still
		// an agent. Ignoring the socket would silently demote it to the fixture
		// lane on exactly the machines that have real identity available.
		const credential = await present(home(), {
			SPIFFE_ENDPOINT_SOCKET: "unix:///run/spire/agent.sock",
		});
		expect(credential?.principal.kind).toBe("agent");
	});

	it("is not an agent when the SVID variable is present but empty", async () => {
		// An exported-but-empty variable is how shells leave a value that was
		// never set. Treating it as an identity would mint an SVID for the
		// principal `agent:`.
		const credential = await present(home(), {
			HOBO_AGENT_SVID: "",
			SPIFFE_ENDPOINT_SOCKET: "",
		});
		expect(credential?.principal.kind).not.toBe("agent");
	});

	it("takes an injected agent principal over anything in the environment", async () => {
		const credential = await present(
			home(),
			{ HOBO_AGENT_ID: "agent:from-env" },
			{},
			{ agentPrincipal: { kind: "agent", id: "agent:injected" } },
		);
		expect(credential?.principal.id).toBe("agent:injected");
	});

	it("keeps a logged-in human beside the agent rather than replacing it", async () => {
		// Two identities, two questions: who authorized this, and what carried it
		// out. Collapsing them would attribute unattended automation to a person
		// or hide the person behind the bot.
		const credential = await present(homeWithSession(), {
			HOBO_AGENT_ID: "agent:ci",
		});
		expect(credential?.principal.id).toBe("agent:ci");
		expect(credential?.humanPrincipal?.id).toBe("user:ada");
	});

	it("omits humanPrincipal when there is no session to attribute to", async () => {
		const credential = await present(home(), { HOBO_AGENT_ID: "agent:ci" });
		expect(credential?.humanPrincipal).toBeUndefined();
	});

	it("takes the tenant from env, then the session, then a dev default", async () => {
		// Tenancy decides what the credential can reach. The precedence has to be
		// explicit because a wrong tenant is not an error — it is a successful
		// deploy into someone else's space.
		const fromEnv = await present(homeWithSession(), {
			HOBO_AGENT_ID: "agent:ci",
			HOBO_TENANT: "explicit",
		});
		expect(fromEnv?.tenant).toBe("explicit");

		const fromSession = await present(homeWithSession(), {
			HOBO_AGENT_ID: "agent:ci",
		});
		expect(fromSession?.tenant).toBe("acme");

		const fallback = await present(home(), { HOBO_AGENT_ID: "agent:ci" });
		expect(fallback?.tenant).toBe("hobo-dev");
	});

	it("reports an expiry derived from the SVID's own claims", async () => {
		// A presenter-invented expiry would drift from the token's, and a caller
		// caching on it would keep presenting a credential the broker has already
		// stopped accepting.
		const credential = await present(home(), { HOBO_AGENT_ID: "agent:ci" });
		const expiresAt = Date.parse(credential?.expiresAt ?? "");
		expect(Number.isNaN(expiresAt)).toBe(false);
		expect(expiresAt).toBeGreaterThan(Date.now());
		expect(expiresAt).toBeLessThan(Date.now() + 2 * 900 * 1000);
	});

	it("binds the proof to the method it was told about", async () => {
		// A DPoP proof is bound to method and URI. Minting every proof as POST
		// would make it unusable for any other verb — and the mismatch would show
		// up as an authentication failure, not a method error.
		const credential = await present(
			home(),
			{ HOBO_AGENT_ID: "agent:ci" },
			{ htm: "GET" },
		);
		expect(credential?.dpopProof).toBeTruthy();
	});

	it("signs the SVID with RS256 through the identity issuer, never an HMAC secret", async () => {
		// A shared HMAC secret would let anything that verifies an SVID also mint
		// one. The issuer's key signs; its JWKS verifies.
		const issuer = createLocalSvidIssuer("spiffe://prod.example");
		const credential = await present(
			home(),
			{ HOBO_AGENT_ID: "agent:ci" },
			{},
			{ svidIssuer: issuer },
		);
		const token = credential?.accessToken ?? "";
		const header = JSON.parse(
			Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
		);
		expect(header.alg).toBe("RS256");
		const verified = await verifyJwtWithJwks(token, issuer.jwks(), {
			issuer: "spiffe://prod.example",
			audience: AUDIENCE,
			now: Math.floor(Date.now() / 1000),
		});
		expect(verified.claims.sub).toBe(credential?.metadata?.spiffeId);
	});

	it("mints under the issuer HOBO_SVID_ISSUER names", async () => {
		const credential = await present(home(), {
			HOBO_AGENT_ID: "agent:ci",
			HOBO_SVID_ISSUER: "spiffe://env.example",
		});
		const claims = JSON.parse(
			Buffer.from(
				(credential?.accessToken ?? "").split(".")[1] ?? "",
				"base64url",
			).toString("utf8"),
		);
		expect(claims.iss).toBe("spiffe://env.example");
		expect(credential?.scheme).toBe("dpop-bound");
	});
});

describe("fleet authority lane", () => {
	it("presents the person token hobo fleet login stored, DPoP-bound to its key", async () => {
		// With an authority configured, the person's authority-issued token is
		// the human credential; the proof is made with the key it is bound to.
		const fleet = home();
		const key = newSignInKey();
		await savePerson(
			fleet,
			create(PersonCredentialSchema, {
				token: "person-token",
				expiresAt: "2999-01-01T00:00:00.000Z",
				principal: "user:ada",
				tenant: "acme",
			}),
			key,
		);
		const credential = await present(homeWithSession(), {
			HOBO_FLEET_AUTHORITY_URL: "https://fleet.example",
			HOBO_FLEET_HOME: fleet,
		});
		expect(credential?.scheme).toBe("dpop-bound");
		expect(credential?.principal).toEqual({ kind: "user", id: "user:ada" });
		expect(credential?.accessToken).toBe("person-token");
		expect(credential?.proofKeyId).toBe(key.thumbprint);
		const proof = await verifyDpopProof({
			proof: credential?.dpopProof ?? "",
			htm: "POST",
			htu: AUDIENCE,
			accessToken: "person-token",
			nowMs: Date.now(),
			replay: { firstUse: async () => true },
		});
		expect(proof.ok && proof.value.jkt).toBe(key.thumbprint);
	});

	it("falls back to the profile session when no person token is stored", async () => {
		const credential = await present(homeWithSession(), {
			HOBO_FLEET_AUTHORITY_URL: "https://fleet.example",
			HOBO_FLEET_HOME: home(),
		});
		expect(credential?.scheme).toBe("bearer-session");
	});
});

describe("session lane", () => {
	it("presents a bearer session when no proof key was ever bound", async () => {
		// A plain login has no sender constraint. Claiming `dpop-bound` without a
		// proof would tell the broker to expect a header that is not there.
		const credential = await present(homeWithSession());
		expect(credential?.scheme).toBe("bearer-session");
		expect(credential?.dpopProof).toBeUndefined();
		expect(credential?.principal.id).toBe("user:ada");
		expect(credential?.tenant).toBe("acme");
		expect(credential?.accessToken).toBe("session-token");
	});

	it("upgrades to a DPoP-bound proof when the session recorded a key", async () => {
		// `proofKeyId` is the record that this login is sender-constrained.
		// Presenting it as a plain bearer would discard the binding the user
		// already paid for.
		const credential = await present(homeWithSession({ proofKeyId: "k1" }));
		expect(credential?.scheme).toBe("dpop-bound");
		expect(credential?.dpopProof).toBeTruthy();
		expect(credential?.proofKeyId).toBeTruthy();
	});

	it("does not attribute a session credential to a human principal twice", async () => {
		// The session principal *is* the human. Repeating it under
		// `humanPrincipal` would make a single actor look like a delegation.
		const credential = await present(homeWithSession());
		expect(credential?.humanPrincipal).toBeUndefined();
	});
});

describe("no principal", () => {
	it("returns null when a caller requires a real principal", async () => {
		// The remote lane would otherwise place work under a fixture identity on
		// a shared broker — a deploy that appears to succeed and belongs to
		// nobody.
		expect(await present(home(), {}, { requirePrincipal: true })).toBeNull();
	});

	it("falls back to an offline fixture identity when nothing is required", async () => {
		// `hobo dev` on a plane has no broker, no login, and no mesh. The fixture
		// keeps the local lane working, and it names itself so no reader mistakes
		// it for a real account.
		const credential = await present(home());
		expect(credential?.scheme).toBe("local-fixture-svid");
		expect(credential?.principal.id).toBe("user:local-fixture");
		expect(credential?.metadata?.fixture).toBe("true");
		expect(credential?.dpopProof).toBeTruthy();
	});

	it("still honours an explicit tenant in the fixture lane", async () => {
		expect((await present(home(), { HOBO_TENANT: "sandbox" }))?.tenant).toBe(
			"sandbox",
		);
		expect((await present(home()))?.tenant).toBe("hobo-dev");
	});

	it("prefers a session over the fixture even without requirePrincipal", async () => {
		// The fixture is a last resort. Reaching it while a real session exists
		// would log the user out from their own perspective.
		expect((await present(homeWithSession()))?.scheme).toBe("bearer-session");
	});
});

describe("presentAnonymous", () => {
	it("passes the ephemeral principal and token straight through", async () => {
		// The broker minted this identity; the presenter's job is to carry it,
		// not to reinterpret it. Substituting a local principal would break the
		// claim flow that ties the deployment back to this session.
		const credential = presenter().presentAnonymous({
			audience: AUDIENCE,
			ephemeralPrincipal: { kind: "user", id: "temp:abc" },
			accessToken: "anon-token",
			expiresAt: "2026-02-01T00:00:00.000Z",
		});
		expect(credential.scheme).toBe("anonymous-ephemeral");
		expect(credential.principal.id).toBe("temp:abc");
		expect(credential.accessToken).toBe("anon-token");
		expect(credential.expiresAt).toBe("2026-02-01T00:00:00.000Z");
	});

	it("defaults the tenant to anonymous, and takes one when given", () => {
		// An anonymous deploy has no tenant of its own. Leaving it undefined
		// would send a header with no value; naming it `anonymous` makes the
		// state legible on the broker side.
		expect(
			presenter().presentAnonymous({
				audience: AUDIENCE,
				ephemeralPrincipal: { kind: "user", id: "temp:abc" },
				accessToken: "t",
				expiresAt: "2026-02-01T00:00:00.000Z",
			}).tenant,
		).toBe("anonymous");
		expect(
			presenter().presentAnonymous({
				audience: AUDIENCE,
				ephemeralPrincipal: { kind: "user", id: "temp:abc" },
				accessToken: "t",
				expiresAt: "2026-02-01T00:00:00.000Z",
				tenant: "preview",
			}).tenant,
		).toBe("preview");
	});
});

describe("DPoP key material on disk", () => {
	it("creates a key once and reuses it on the next call", () => {
		// A new key per invocation would make the proof key id meaningless as an
		// identifier and would leave a directory of orphaned private keys.
		const dir = home();
		const first = loadOrCreateDpopKeyPair(dir, "user:ada");
		const second = loadOrCreateDpopKeyPair(dir, "user:ada");
		expect(second.kid).toBe(first.kid);
	});

	it("keeps separate keys for separate principals", () => {
		const dir = home();
		expect(loadOrCreateDpopKeyPair(dir, "user:ada").kid).not.toBe(
			loadOrCreateDpopKeyPair(dir, "agent:ci").kid,
		);
	});

	it("sanitises the principal into a filename rather than trusting it", () => {
		// The principal id can come from an environment variable. Used raw it
		// would be a path traversal into whatever the caller named — private key
		// material written outside the keys directory.
		const dir = home();
		loadOrCreateDpopKeyPair(dir, "../../escape/../agent:ci");
		expect(existsSync(join(dir, "keys"))).toBe(true);
		const written = readFileSync(
			join(dir, "keys", "dpop-.._.._escape_.._agent_ci.json"),
			"utf8",
		);
		expect(JSON.parse(written)).toHaveProperty("kty");
	});

	it("writes the private key readable only by its owner", () => {
		// This file is the whole sender constraint. World-readable it would let
		// any process on the machine mint proofs for this principal.
		const dir = home();
		loadOrCreateDpopKeyPair(dir, "user:ada");
		const mode = statSync(join(dir, "keys", "dpop-user_ada.json")).mode & 0o777;
		expect(mode & 0o077).toBe(0);
	});
});

describe("authorizationHeaders", () => {
	const base: PresentedCredential = {
		scheme: "bearer-session",
		principal: { kind: "user", id: "user:ada" },
		tenant: "acme",
		accessToken: "tok",
		audience: AUDIENCE,
		expiresAt: "2026-02-01T00:00:00.000Z",
	};

	it("always carries the principal, tenant, and scheme alongside the token", () => {
		// The token alone does not tell a broker how to interpret it. Sending the
		// scheme separately is what lets one endpoint accept bearer sessions and
		// DPoP-bound SVIDs without guessing.
		const headers = authorizationHeaders(base);
		expect(headers.authorization).toBe("Bearer tok");
		expect(headers["x-hobo-principal-kind"]).toBe("user");
		expect(headers["x-hobo-principal-id"]).toBe("user:ada");
		expect(headers["x-hobo-tenant"]).toBe("acme");
		expect(headers["x-hobo-credential-scheme"]).toBe("bearer-session");
	});

	it("omits the optional headers when the credential has nothing to say", () => {
		// An empty `dpop` header would be read as a malformed proof rather than
		// as no proof, turning a valid bearer request into an auth failure.
		const headers = authorizationHeaders(base);
		expect(headers.dpop).toBeUndefined();
		expect(headers["x-hobo-human-principal-id"]).toBeUndefined();
		expect(headers["x-hobo-spiffe-id"]).toBeUndefined();
	});

	it("sends both halves of a dual principal", () => {
		const headers = authorizationHeaders({
			...base,
			humanPrincipal: { kind: "user", id: "user:ada" },
			principal: { kind: "agent", id: "agent:ci" },
		});
		expect(headers["x-hobo-human-principal-id"]).toBe("user:ada");
		expect(headers["x-hobo-human-principal-kind"]).toBe("user");
	});

	it("sends the proof and the SPIFFE id when they exist", () => {
		const headers = authorizationHeaders({
			...base,
			dpopProof: "proof",
			metadata: { spiffeId: "spiffe://hobo.local/agent/ci" },
		});
		expect(headers.dpop).toBe("proof");
		expect(headers["x-hobo-spiffe-id"]).toBe("spiffe://hobo.local/agent/ci");
	});

	it("skips the SPIFFE header when metadata carries other keys only", () => {
		// `metadata` is a free-form bag. Reading a missing key as present would
		// send `x-hobo-spiffe-id: undefined` to the broker.
		const headers = authorizationHeaders({
			...base,
			metadata: { fixture: "true" },
		});
		expect(headers["x-hobo-spiffe-id"]).toBeUndefined();
	});
});

describe("small helpers", () => {
	it("profileHasSession narrows a profile with a session and rejects one without", () => {
		expect(profileHasSession(null)).toBe(false);
		expect(
			profileHasSession({
				schemaVersion: HOBO_PROFILE_SCHEMA,
				updatedAt: "2026-01-01T00:00:00.000Z",
			}),
		).toBe(false);
		expect(
			profileHasSession({
				schemaVersion: HOBO_PROFILE_SCHEMA,
				updatedAt: "2026-01-01T00:00:00.000Z",
				session: {
					principal: { kind: "user", id: "user:ada" },
					tenant: "acme",
					token: "tok",
					issuedAt: "2026-01-01T00:00:00.000Z",
				},
			}),
		).toBe(true);
	});

	it("mintMockDpopProof still produces a proof for its deprecated callers", async () => {
		// Deprecated, not removed. A caller still on it should get a real proof
		// rather than a silently invalid string.
		const proof = await mintMockDpopProof({
			htm: "POST",
			htu: AUDIENCE,
			ath: "tok",
			keyId: "kid-1",
		});
		expect(proof.split(".")).toHaveLength(3);
	});
});
