/**
 * O28: every route of §6.15 admits exactly its auth modes. For every route
 * and every caller kind (none, person, device, account credential, workload
 * OIDC token, self-minted token, DPoP key mismatch) the cell answers as the
 * Auth column allows; every other cell is refused `unauthenticated`
 * (or another 401 proof failure) or `forbidden`. The routes whose credential
 * is not a caller kind (the browser session, the sign-in key, the identity
 * key) refuse every kind and admit only their own credential. The device-code
 * flow is refused for a `DUAL` fleet, and the approval page renders every
 * field of `ApprovalView`.
 */
import { create, fromBinary, toJsonString } from "@bufbuild/protobuf";
import {
	ApprovalMode,
	CoordinationMode,
	DeclareRequestSchema,
	FleetPolicySchema,
	FleetRecordSchema,
	MemberKind,
	MemberRecordSchema,
	OidcTrustRuleSchema,
	RepositoryRuleSchema,
	Role,
} from "@hobo/fleet";
import {
	createMemoryCredentialIssuer,
	generateDpopKey,
	jwkThumbprint,
} from "@hobo/fleet/keys";
import { beforeAll, describe, expect, it } from "vitest";
import { type CallerKind, ROUTES, type Route } from "../src/service/routes.js";
import {
	ACCOUNT_CREDENTIAL,
	type Caller,
	createHarness,
	credentialBody,
	type Device,
	enrollmentBody,
	fleetBody,
	type Harness,
	newDevice,
	tokenBody,
	WORKLOAD_TOKEN,
} from "./support/harness.js";

const KINDS = [
	"none",
	"person",
	"device",
	"account",
	"workload",
	"self-minted",
	"dpop-mismatch",
] as const;
type Kind = (typeof KINDS)[number];
/** What the Auth column names, as caller kinds. */
const KIND_OF = {
	none: undefined,
	person: "person",
	device: "member",
	account: "account",
	workload: "workload",
	"self-minted": undefined,
	"dpop-mismatch": undefined,
} as const satisfies Readonly<Record<Kind, CallerKind | undefined>>;
const AUTH_REFUSALS = new Set([
	"unauthenticated",
	"proof-invalid",
	"proof-replayed",
	"forbidden",
]);

function admittedKinds(route: Route): readonly Kind[] {
	if (route.auth === "none") return KINDS;
	if (
		route.auth === "browser" ||
		route.auth === "signin-key" ||
		route.auth === "identity-key"
	)
		return [];
	const allowed = route.auth;
	return KINDS.filter((kind) => {
		const callerKind = KIND_OF[kind];
		return callerKind !== undefined && allowed.includes(callerKind);
	});
}

type Request = Readonly<{
	path: string;
	body?: string;
	headers?: Readonly<Record<string, string>>;
}>;

let h: Harness;
let person: Caller;
let device: Device;
let generation = 1;
const callers = new Map<Kind, Caller>();
let backendId = "";
let fleetCounter = 0;
let declareCounter = 0;

async function enrollDevice(fleet: string, name: string): Promise<Device> {
	const token = await h.send("POST", "/v1/fleet/tokens", {
		caller: person,
		body: tokenBody(fleet, name),
	});
	if (token.status !== 200) throw new Error(token.text);
	const fresh = await newDevice(h.now());
	const enrolled = await h.send("POST", "/v1/fleet/members", {
		body: enrollmentBody(
			fresh,
			fleet,
			{ bootstrapToken: token.json().token },
			name,
		),
		dpop: fresh.identityKey,
	});
	if (enrolled.status !== 200) throw new Error(enrolled.text);
	await h.runtime.tickOnce();
	return fresh;
}

async function deviceCaller(subject: Device, gen: number): Promise<Caller> {
	const answer = await h.send(
		"POST",
		`/v1/fleet/members/${subject.keys.memberId}/credentials`,
		{
			body: credentialBody(gen),
			dpop: subject.signKey,
		},
	);
	if (answer.status !== 200) throw new Error(answer.text);
	const svid: string = answer.json().svid;
	return {
		authorization: `DPoP ${svid}`,
		dpopKey: subject.signKey,
		token: svid,
	};
}

/** A request for each route that passes every check but authentication when the caller is admitted. */
async function requestFor(route: Route, kind: Kind): Promise<Request> {
	const member = device.keys.memberId;
	switch (route.api) {
		case "authorityDiscovery":
			return { path: "/.well-known/hobo-fleet" };
		case "discovery":
			return { path: "/v1/fleet/tenants/test/discovery" };
		case "jwks":
			return { path: "/v1/fleet/jwks" };
		case "signInStart": {
			const key = generateDpopKey();
			return {
				path: "/v1/fleet/signin/start",
				body: JSON.stringify({
					provider: "test",
					tenant: "test",
					deviceFlow: true,
					codeChallenge: jwkThumbprint(generateDpopKey().publicJwk),
					dpopThumbprint: jwkThumbprint(key.publicJwk),
				}),
			};
		}
		case "signInDevice": {
			const flow = await h.startSignIn("user:alice", true);
			return {
				path: "/v1/fleet/signin/device",
				body: JSON.stringify({ userCode: flow.challenge.userCode }),
			};
		}
		case "signInCallback": {
			const flow = await h.startSignIn("user:alice");
			return {
				path: `/v1/fleet/signin/callback?state=${encodeURIComponent(flow.state)}&code=user:alice`,
			};
		}
		case "approval":
		case "approve": {
			const flow = await h.startSignIn("user:alice");
			await flow.callback();
			const path = `/v1/fleet/approve/${encodeURIComponent(flow.state)}`;
			if (route.api === "approval") return { path };
			return { path, body: JSON.stringify({ approve: true }) };
		}
		case "signInComplete": {
			const flow = await h.startSignIn("user:alice");
			const { cookie } = await flow.callback();
			const code = await flow.decide(cookie);
			return {
				path: "/v1/fleet/signin/complete",
				body: JSON.stringify({
					state: flow.state,
					code,
					codeVerifier: flow.verifier,
				}),
			};
		}
		case "signInPoll": {
			const flow = await h.startSignIn("user:alice", true);
			return {
				path: "/v1/fleet/signin/device/poll",
				body: JSON.stringify({ state: flow.state }),
			};
		}
		case "signInRefresh":
			return { path: "/v1/fleet/signin/refresh", body: "{}" };
		case "issueToken":
			return {
				path: "/v1/fleet/tokens",
				body: tokenBody("build", `t${fleetCounter++}`),
			};
		case "listTokens":
			return { path: "/v1/fleet/tokens" };
		case "revokeToken": {
			const issued = await h.send("POST", "/v1/fleet/tokens", {
				caller: person,
				body: tokenBody("build", `r${fleetCounter++}`),
			});
			return { path: `/v1/fleet/tokens/${issued.json().tokenHash}` };
		}
		case "enroll": {
			const issued = await h.send("POST", "/v1/fleet/tokens", {
				caller: person,
				body: tokenBody("build", `e${fleetCounter++}`),
			});
			const fresh = await newDevice(h.now());
			return {
				path: "/v1/fleet/members",
				body: enrollmentBody(
					fresh,
					"build",
					{ bootstrapToken: issued.json().token },
					`e${fleetCounter - 1}`,
				),
			};
		}
		case "declare":
			return {
				path: "/v1/fleet/members:declare",
				body: toJsonString(
					DeclareRequestSchema,
					create(DeclareRequestSchema, {
						tenant: "test",
						fleet: "build",
						kind: MemberKind.BACKEND,
						name: `d${declareCounter++}-${kind.replace(/[^a-z]/gu, "")}`,
						region: "eu-west-1",
					}),
				),
			};
		case "approveKey":
		case "accept":
		case "reject":
		case "suspend":
		case "resume":
		case "unlock":
		case "revoke": {
			const verb = route.path.split("/").at(-1) ?? "";
			return {
				path: `/v1/fleet/members/${backendId}/${verb}`,
				body: JSON.stringify({ reason: "matrix" }),
			};
		}
		case "assign":
			return {
				path: `/v1/fleet/members/${backendId}/memberships`,
				body: JSON.stringify({ fleet: "build", name: "again" }),
			};
		case "credentials":
			return {
				path: `/v1/fleet/members/${member}/credentials`,
				body: credentialBody(generation),
			};
		case "rotateKeys":
			return { path: `/v1/fleet/members/${member}/keys`, body: "{}" };
		case "leave":
			return { path: `/v1/fleet/members/${member}/leave` };
		case "listMembers":
			return { path: "/v1/fleet/members?fleet=build" };
		case "getMember":
			return { path: `/v1/fleet/members/${member}` };
		case "listFleets":
			return { path: "/v1/fleet/fleets" };
		case "getFleet":
			return { path: "/v1/fleet/fleets/build" };
		case "defineFleet": {
			const id = `f${fleetCounter++}`;
			return { path: `/v1/fleet/fleets/${id}`, body: fleetBody(id) };
		}
		case "fleetView":
			return { path: "/v1/fleet/fleets/build/view" };
		case "fleetVerdict":
			return { path: "/v1/fleet/fleets/build/verdict?label=linux" };
		case "grantSession":
			return {
				path: "/v1/fleet/sessions",
				body: JSON.stringify({
					peer: member,
					purpose: "SESSION_PURPOSE_SHELL",
					ttlSeconds: 60,
				}),
			};
		case "submitWork":
			return {
				path: "/v1/fleet/work",
				body: JSON.stringify({ fleet: "build" }),
			};
		case "workStatus":
			return { path: "/v1/fleet/work/missing" };
		case "workLogs":
			return { path: "/v1/fleet/work/missing/logs" };
		case "report":
			return {
				path: "/v1/fleet/reports",
				body: JSON.stringify({ kind: "claim-early" }),
			};
		case "auditCheckpoints":
			return { path: "/v1/fleet/audit/checkpoints?from=0" };
		case "auditEntries":
			return { path: "/v1/fleet/audit/entries?from=1&to=2" };
	}
}

/** Routes that change the device itself get a disposable one, so later cells keep theirs. */
async function callerFor(
	route: Route,
	kind: Kind,
): Promise<Caller | undefined> {
	if (
		kind === "device" &&
		(route.api === "rotateKeys" || route.api === "leave")
	) {
		const fresh = await enrollDevice("build", `x${fleetCounter++}`);
		device = fresh;
		const caller = await deviceCaller(fresh, 0);
		return caller;
	}
	return callers.get(kind);
}

beforeAll(async () => {
	h = await createHarness();
	const bootstrapAdmin = await h.personCaller({ kind: "user", id: "alice" }, [
		"fleet-admin",
		"auditor",
	]);
	const policy = create(FleetPolicySchema, {
		approval: ApprovalMode.AUTO_OWNER,
		allowedKinds: [MemberKind.DEVICE, MemberKind.BACKEND],
		allowedRoles: [Role.EXECUTOR, Role.DISPATCHER],
		repositories: [
			create(RepositoryRuleSchema, {
				repository: "acme/app",
				refs: ["refs/heads/main"],
			}),
		],
		oidcTrust: [
			create(OidcTrustRuleSchema, {
				issuer: "https://token.actions.githubusercontent.com",
				subjectPattern: "repo:acme/app:.*",
				sponsor: true,
			}),
		],
	});
	const defined = await h.send("PUT", "/v1/fleet/fleets/build", {
		caller: bootstrapAdmin,
		body: toJsonString(
			FleetRecordSchema,
			create(FleetRecordSchema, {
				fleetId: "build",
				coordination: CoordinationMode.MANY_ACTIVE,
				policy,
			}),
		),
	});
	if (defined.status !== 200) throw new Error(defined.text);
	await h.runtime.tickOnce();

	// The person is signed in through the routes, so refresh has a sign-in to extend.
	person = await h.signedIn("user:alice");
	device = await enrollDevice("build", "box1");
	const deviceToken = await deviceCaller(device, 0);
	const backend = await h.send("POST", "/v1/fleet/members:declare", {
		caller: person,
		body: toJsonString(
			DeclareRequestSchema,
			create(DeclareRequestSchema, {
				tenant: "test",
				fleet: "build",
				kind: MemberKind.BACKEND,
				name: "store",
				region: "eu-west-1",
			}),
		),
	});
	if (backend.status !== 200) throw new Error(backend.text);
	backendId = fromBinary(
		MemberRecordSchema,
		Buffer.from(backend.json().memberRecord.payload, "base64"),
	).memberId;
	expect(backendId).toMatch(/^bkd_/u);

	const foreign = createMemoryCredentialIssuer(h.now);
	const foreignKey = generateDpopKey();
	const selfMinted = await foreign.issuePerson({
		principal: { kind: "user", id: "alice" },
		tenant: h.tenant,
		tags: ["fleet-admin", "auditor"],
		jkt: jwkThumbprint(foreignKey.publicJwk),
		ttlMs: 600_000,
	});
	callers.set("none", { authorization: "", dpopKey: undefined, token: "" });
	callers.set("person", person);
	callers.set("device", deviceToken);
	callers.set("account", {
		authorization: `Bearer ${ACCOUNT_CREDENTIAL}`,
		dpopKey: undefined,
		token: "",
	});
	callers.set("workload", {
		authorization: `Bearer ${WORKLOAD_TOKEN}`,
		dpopKey: undefined,
		token: "",
	});
	callers.set("self-minted", {
		authorization: `DPoP ${selfMinted.token}`,
		dpopKey: foreignKey,
		token: selfMinted.token,
	});
	callers.set("dpop-mismatch", {
		authorization: person.authorization,
		dpopKey: generateDpopKey(),
		token: person.token,
	});
	generation = 1;
}, 60_000);

describe("O28: every route admits exactly its auth modes", () => {
	it("covers every route of §6.15 once", () => {
		// One route per FleetApi method (41); /healthz and /readyz are not FleetApi methods.
		expect(ROUTES).toHaveLength(41);
		expect(new Set(ROUTES.map((route) => route.api)).size).toBe(41);
	});

	for (const route of ROUTES) {
		const admitted = admittedKinds(route);
		for (const kind of KINDS) {
			const allowed = admitted.includes(kind);
			it(`${route.method} ${route.path} as ${kind}: ${allowed ? "admitted" : "refused"}`, async () => {
				const caller = await callerFor(route, kind);
				const request = await requestFor(route, kind);
				const options: Parameters<Harness["send"]>[2] = {
					caller,
					body: request.body,
				};
				const answer = await h.send(route.method, request.path, options);
				if (allowed) {
					const code: string =
						answer.status >= 400 && answer.text.startsWith("{")
							? (answer.json().code ?? "")
							: "";
					expect(
						AUTH_REFUSALS.has(code),
						`${answer.status} ${answer.text}`,
					).toBe(false);
					if (route.api === "credentials" && answer.status === 200)
						generation += 1;
				} else {
					expect([401, 403], answer.text).toContain(answer.status);
					expect(AUTH_REFUSALS.has(answer.json().code), answer.text).toBe(true);
				}
			});
		}
	}
});

describe("routes whose credential is not a caller kind", () => {
	it("the approval page needs the callback's browser session, and renders every field of ApprovalView", async () => {
		const flow = await h.startSignIn("user:alice");
		const { answer, cookie } = await flow.callback();
		expect(answer.status).toBe(303);
		expect(answer.headers.get("location")).toBe(
			`https://authority.fleet.test/v1/fleet/approve/${encodeURIComponent(flow.state)}`,
		);
		expect(answer.headers.get("set-cookie")).toMatch(
			/Secure; HttpOnly; SameSite=Lax/u,
		);

		const other = await h.startSignIn("user:alice");
		const stolen = (await other.callback()).cookie;
		const refused = await h.send(
			"GET",
			`/v1/fleet/approve/${encodeURIComponent(flow.state)}`,
			{ headers: { cookie: stolen } },
		);
		expect(refused.status).toBe(401);

		const page = await h.send(
			"GET",
			`/v1/fleet/approve/${encodeURIComponent(flow.state)}`,
			{ headers: { cookie, accept: "text/html" } },
		);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toMatch(/^text\/html/u);
		const json = await h.send(
			"GET",
			`/v1/fleet/approve/${encodeURIComponent(flow.state)}`,
			{ headers: { cookie, accept: "application/json" } },
		);
		const view = json.json();
		const fields = {
			state: view.state,
			principal: view.principal,
			host_name: view.hostName,
			device_name: view.deviceName,
			platform: `${view.platform.os} / ${view.platform.arch}`,
			fingerprint_words: view.fingerprintWords.join(" "),
			device_flow: "browser",
			expires_at: view.expiresAt,
		};
		expect(Object.keys(fields).sort()).toEqual([
			"device_flow",
			"device_name",
			"expires_at",
			"fingerprint_words",
			"host_name",
			"platform",
			"principal",
			"state",
		]);
		for (const [name, value] of Object.entries(fields)) {
			expect(value.length, name).toBeGreaterThan(0);
			expect(page.text, name).toContain(`data-field="${name}"`);
			expect(page.text, name).toContain(value.replaceAll("&", "&amp;"));
		}
		expect(view.fingerprintWords).toHaveLength(4);

		const decided = await h.send(
			"POST",
			`/v1/fleet/approve/${encodeURIComponent(flow.state)}`,
			{
				body: `state=${encodeURIComponent(flow.state)}&approve=true`,
				headers: {
					cookie,
					"content-type": "application/x-www-form-urlencoded",
					accept: "text/html",
				},
			},
		);
		expect(decided.status).toBe(303);
		const location = new URL(decided.headers.get("location") ?? "");
		expect(location.origin).toBe("http://127.0.0.1:5555");
		const done = await flow.complete(location.searchParams.get("code") ?? "");
		expect(done.status, done.text).toBe(200);
	});

	it("complete and poll admit only the sign-in key", async () => {
		const flow = await h.startSignIn("user:bob");
		const { cookie } = await flow.callback();
		const code = await flow.decide(cookie);
		const wrong = await flow.complete(code, generateDpopKey());
		expect(wrong.status).toBe(401);
		expect(wrong.json().code).toBe("proof-invalid");
		const right = await flow.complete(code);
		expect(right.status, right.text).toBe(200);

		const device = await h.startSignIn("user:bob", true);
		expect((await device.poll(generateDpopKey())).json().code).toBe(
			"proof-invalid",
		);
		const pending = await device.poll();
		expect(pending.status).toBe(428);
		expect(pending.json().code).toBe("sign-in-pending");
	});

	it("enrollment admits only a DPoP proof made with the request's identity key", async () => {
		const issued = await h.send("POST", "/v1/fleet/tokens", {
			caller: person,
			body: tokenBody("build", "idkey"),
		});
		const fresh = await newDevice(h.now());
		const body = enrollmentBody(
			fresh,
			"build",
			{ bootstrapToken: issued.json().token },
			"idkey",
		);
		const other = await newDevice(h.now());
		const signKey = await h.send("POST", "/v1/fleet/members", {
			body,
			dpop: fresh.signKey,
		});
		expect(signKey.json().code).toBe("proof-invalid");
		const foreign = await h.send("POST", "/v1/fleet/members", {
			body,
			dpop: other.identityKey,
		});
		expect(foreign.json().code).toBe("proof-invalid");
		const none = await h.send("POST", "/v1/fleet/members", { body });
		expect(none.json().code).toBe("unauthenticated");
		const right = await h.send("POST", "/v1/fleet/members", {
			body,
			dpop: fresh.identityKey,
		});
		expect(right.status, right.text).toBe(200);
	});
});

describe("dual control", () => {
	it("refuses a person token from the device-code flow for a DUAL fleet, and admits the browser flow", async () => {
		const defined = await h.send("PUT", "/v1/fleet/fleets/vault", {
			caller: person,
			body: fleetBody("vault", ApprovalMode.DUAL),
		});
		expect(defined.status, defined.text).toBe(200);
		await h.runtime.tickOnce();

		// The device signs its person in with its identity key, by device code.
		const fresh = await newDevice(h.now());
		const flow = await h.startSignIn("user:alice", true, fresh.identityKey);
		const verify = await h.send("POST", "/v1/fleet/signin/device", {
			body: JSON.stringify({ userCode: flow.challenge.userCode }),
		});
		expect(verify.status, verify.text).toBe(200);
		const { cookie } = await flow.callback();
		await flow.decide(cookie);
		const polled = await flow.poll();
		expect(polled.status, polled.text).toBe(200);
		const deviceCode = await h.send("POST", "/v1/fleet/members", {
			body: enrollmentBody(
				fresh,
				"vault",
				{ personToken: polled.json().token },
				"vaultbox",
			),
			dpop: fresh.identityKey,
		});
		expect(deviceCode.status).toBe(403);
		expect(deviceCode.json()).toMatchObject({
			code: "fleet-policy",
			detail: { rule: "dual-control-device-code" },
		});

		// A device whose person signed in by the browser flow is admitted (and waits for two approvers).
		const second = await newDevice(h.now());
		const browser = await h.startSignIn(
			"user:alice",
			false,
			second.identityKey,
		);
		const session = await browser.callback();
		const code = await browser.decide(session.cookie);
		const completed = await browser.complete(code);
		expect(completed.status, completed.text).toBe(200);
		const enrolled = await h.send("POST", "/v1/fleet/members", {
			body: enrollmentBody(
				second,
				"vault",
				{ personToken: completed.json().token },
				"vaultbox2",
			),
			dpop: second.identityKey,
		});
		expect(enrolled.status, enrolled.text).toBe(200);
	});
});
