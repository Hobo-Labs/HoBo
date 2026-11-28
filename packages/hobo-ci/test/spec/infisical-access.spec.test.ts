import { describe, expect, it } from "vitest";
import { provisionInfisicalAccess } from "../../src/infisical-access.js";
import {
	type CommandResult,
	INFISICAL_CLI,
	type RunCommand,
} from "../../src/store-cli.js";

// SPEC: connecting Infisical with as little manual provisioning as Infisical
// allows. The owner signs in once, with Infisical's own CLI; HoBo installs
// that CLI when it is missing, reuses a session that already exists, and
// creates everything else through Infisical's API: the machine identity, its
// auth method (OIDC where the workload has an issuer, else Token Auth), its
// project membership and its token. The owner never creates an identity or
// token by hand, sets an environment variable, or types into a terminal.
//
// R3  An existing CLI session is used: no sign-in, no question.
// R4  OIDC Auth is preferred to a bearer token where the workload has an issuer.
// R5  At most one sign-in, through the CLI; the rest goes through the API.
// R7  Choosing Infisical installs its CLI if it is missing, into HoBo's own
//     tools directory (never globally), and reuses it after that.

const TOOLS = "/home/owner/.local/share/hobo/tools";
const ORG = "org-1";
const PROJECT = "proj-1";
// A user session token as `infisical user get token --plain` prints it: a JWT
// whose payload names the organization.
const USER_JWT = `h.${Buffer.from(JSON.stringify({ organizationId: ORG })).toString("base64url")}.s`;

interface FakeProject {
	id: string;
	name: string;
	slug: string;
	type?: string;
	environments: { name: string; slug: string; id: string }[];
}

const env = (slug: string) => ({ name: slug, slug, id: `env-${slug}` });

const secretsProject = (
	id: string,
	name: string,
	slugs: readonly string[] = ["dev", "staging", "prod"],
): FakeProject => ({
	id,
	name,
	slug: name,
	type: "secret-manager",
	environments: slugs.map(env),
});

/** Infisical's API as the run reaches it, recording what was created. */
function fakeInfisical(
	projects: FakeProject[] = [secretsProject(PROJECT, "secrets")],
) {
	const calls: {
		method: string;
		path: string;
		query: string;
		body: unknown;
		auth: string;
	}[] = [];
	const folders: { project: string; environment: string; path: string }[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		const auth = new Headers(init?.headers).get("authorization") ?? "";
		calls.push({ method, path: url.pathname, query: url.search, body, auth });
		if (auth !== `Bearer ${USER_JWT}`)
			return Response.json({ message: "unauthorized" }, { status: 401 });
		const byId = (id: string | null) =>
			projects.find((project) => project.id === id);
		if (url.pathname === "/api/v1/projects" && method === "GET")
			return Response.json({
				projects: projects.filter(
					(project) =>
						url.searchParams.get("type") === null ||
						project.type === url.searchParams.get("type"),
				),
			});
		if (url.pathname === "/api/v1/projects" && method === "POST") {
			const made = secretsProject("proj-made", body.projectName);
			projects.push(made);
			return Response.json({ project: made });
		}
		const projectPath = /^\/api\/v1\/projects\/([^/]+)(\/.*)?$/u.exec(
			url.pathname,
		);
		if (projectPath !== null) {
			const project = byId(projectPath[1] ?? null);
			if (project === undefined)
				return Response.json(
					{ message: `Project with ${projectPath[1]} not found` },
					{ status: 404 },
				);
			const rest = projectPath[2] ?? "";
			if (rest === "" && method === "GET") return Response.json({ project });
			if (rest === "/environments" && method === "POST") {
				project.environments.push(env(body.slug));
				return Response.json({ environment: env(body.slug) });
			}
			if (rest === "/memberships/identities" && method === "GET")
				return Response.json({ identityMemberships: [], totalCount: 0 });
			if (rest === "/memberships/identities/ident-1")
				return Response.json({ identityMembership: { id: "m-1" } });
		}
		if (url.pathname === "/api/v1/folders") {
			const workspace =
				method === "GET"
					? url.searchParams.get("workspaceId")
					: body.workspaceId;
			const environment =
				method === "GET"
					? url.searchParams.get("environment")
					: body.environment;
			const project = byId(workspace);
			if (project === undefined)
				return Response.json(
					{ message: `Project with ${workspace} not found` },
					{ status: 404 },
				);
			if (project.type !== "secret-manager")
				return Response.json(
					{
						message: `The project is of type ${project.type}. Operations of type secret-manager are not allowed.`,
					},
					{ status: 400 },
				);
			if (!project.environments.some((e) => e.slug === environment))
				return Response.json(
					{ message: `Environment with slug '${environment}' not found` },
					{ status: 404 },
				);
			if (method === "POST") {
				folders.push({
					project: project.id,
					environment: String(environment),
					path: `${body.path === "/" ? "" : body.path}/${body.name}`,
				});
				return Response.json({ folder: { id: "f-1", name: body.name } });
			}
			return Response.json({ folders: [] });
		}
		if (url.pathname === `/api/v2/organizations/${ORG}/identity-memberships`)
			return Response.json({ identityMemberships: [], totalCount: 0 });
		if (url.pathname === "/api/v1/identities")
			return Response.json({ identity: { id: "ident-1", name: body.name } });
		if (url.pathname === "/api/v1/auth/token-auth/identities/ident-1")
			return Response.json({ identityTokenAuth: { id: "ta-1" } });
		if (url.pathname === "/api/v1/auth/oidc-auth/identities/ident-1")
			return Response.json({ identityOidcAuth: { id: "oa-1" } });
		if (url.pathname === "/api/v1/auth/token-auth/identities/ident-1/tokens")
			return Response.json({ accessToken: "identity-token", expiresIn: 3600 });
		return Response.json({ message: "not found" }, { status: 404 });
	};
	return { calls, folders, projects, fetch: fetchImpl };
}

/** A machine: which commands exist, whether the CLI is signed in. */
function fakeMachine(options: { cliOnPath?: boolean; signedIn?: boolean }) {
	const ran: string[] = [];
	let installed = false;
	let signedIn = options.signedIn ?? false;
	const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
	const run: RunCommand = async (command, args) => {
		ran.push([command, ...args].join(" "));
		if (command === "npm" && args.includes("install")) {
			installed = true;
			return ok();
		}
		const isCli =
			command === "infisical" ||
			command === `${TOOLS}/node_modules/.bin/infisical`;
		if (!isCli) return { code: 127, stdout: "", stderr: "not found" };
		if (args.join(" ") === "login status")
			return signedIn
				? ok("Logged in")
				: { code: 1, stdout: "", stderr: "not logged in" };
		if (args.join(" ") === "login") {
			signedIn = true; // the owner signed in in their browser
			return ok();
		}
		if (args.join(" ") === "user get token --plain") return ok(USER_JWT);
		return { code: 2, stdout: "", stderr: `unexpected ${args.join(" ")}` };
	};
	const which = async (bin: string) =>
		options.cliOnPath && bin === "infisical"
			? "/usr/bin/infisical"
			: installed && bin === INFISICAL_CLI.bin
				? undefined
				: undefined;
	return {
		ran,
		run,
		which,
		signedIn: () => signedIn,
		installed: () => installed,
	};
}

const lines: string[] = [];
const base = (
	machine: ReturnType<typeof fakeMachine>,
	api: ReturnType<typeof fakeInfisical>,
) => ({
	family: "cd" as const,
	projectId: PROJECT,
	run: machine.run,
	which: machine.which,
	toolsDir: TOOLS,
	fetch: api.fetch,
	emit: (line: string) => lines.push(line),
	interactive: true,
});

describe("SPEC R7: choosing Infisical installs its CLI when missing", () => {
	it("installs @infisical/cli into HoBo's tools directory, never globally", async () => {
		const machine = fakeMachine({ signedIn: true });
		await provisionInfisicalAccess(base(machine, fakeInfisical()));
		const install = machine.ran.find((c) => c.startsWith("npm install"));
		expect(install).toContain(`--prefix ${TOOLS}`);
		expect(install).toContain("@infisical/cli@");
		expect(install).not.toMatch(/\s-g\b|--global/u);
		expect(machine.ran).toContain(
			`${TOOLS}/node_modules/.bin/infisical login status`,
		);
	});

	it("uses a CLI already on the machine and installs nothing", async () => {
		const machine = fakeMachine({ cliOnPath: true, signedIn: true });
		await provisionInfisicalAccess(base(machine, fakeInfisical()));
		expect(machine.ran.some((c) => c.startsWith("npm"))).toBe(false);
	});
});

describe("SPEC R3 + R5: an existing session is used; otherwise one sign-in", () => {
	it("uses an existing CLI session without signing in or asking anything", async () => {
		lines.length = 0;
		const machine = fakeMachine({ cliOnPath: true, signedIn: true });
		const result = await provisionInfisicalAccess(
			base(machine, fakeInfisical()),
		);
		expect(result.kind).toBe("ready");
		expect(machine.ran).not.toContain("infisical login");
		expect(lines).toEqual([]);
	});

	it("signs in once with the CLI when there is no session, then continues", async () => {
		const machine = fakeMachine({ cliOnPath: true, signedIn: false });
		const result = await provisionInfisicalAccess(
			base(machine, fakeInfisical()),
		);
		expect(machine.ran.filter((c) => c === "infisical login")).toHaveLength(1);
		expect(result.kind).toBe("ready");
	});
});

describe("SPEC R1 + R4: HoBo creates the identity through the API", () => {
	it("creates the identity, Token Auth, a token and the project membership", async () => {
		const api = fakeInfisical();
		const result = await provisionInfisicalAccess(
			base(fakeMachine({ cliOnPath: true, signedIn: true }), api),
		);
		expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			`GET /api/v1/projects/${PROJECT}`,
			`GET /api/v2/organizations/${ORG}/identity-memberships`,
			"POST /api/v1/identities",
			"POST /api/v1/auth/token-auth/identities/ident-1",
			`GET /api/v1/projects/${PROJECT}/memberships/identities`,
			`POST /api/v1/projects/${PROJECT}/memberships/identities/ident-1`,
			"POST /api/v1/auth/token-auth/identities/ident-1/tokens",
		]);
		expect(api.calls[2]?.body).toMatchObject({
			organizationId: ORG,
			role: "no-access",
		});
		expect(result).toMatchObject({
			kind: "ready",
			identityId: "ident-1",
			projectId: PROJECT,
			environment: "prod",
			auth: "token",
			token: "identity-token",
		});
	});

	it("says what Infisical answered when it refuses a step", async () => {
		const api = fakeInfisical();
		const refusing: typeof fetch = async (input, init) =>
			new URL(String(input)).pathname.endsWith("/identity-memberships")
				? new Response(
						JSON.stringify({ message: "Environment with slug prod not found" }),
						{ status: 400 },
					)
				: api.fetch(input, init);
		const result = await provisionInfisicalAccess({
			...base(fakeMachine({ cliOnPath: true, signedIn: true }), api),
			fetch: refusing,
		});
		expect(result).toMatchObject({
			kind: "refused",
			message:
				"Infisical refused listing the organization's identities (HTTP 400): Environment with slug prod not found.",
		});
	});

	it("prefers OIDC Auth when the workload has an issuer, and mints no bearer token", async () => {
		const api = fakeInfisical();
		const result = await provisionInfisicalAccess({
			...base(fakeMachine({ cliOnPath: true, signedIn: true }), api),
			workloadOidc: {
				discoveryUrl: "https://oidc.vercel.com/team",
				issuer: "https://oidc.vercel.com/team",
				audience: "https://vercel.com/team",
				subject: "owner:team:project:hobo-ci:environment:production",
			},
		});
		const paths = api.calls.map((c) => c.path);
		expect(paths).toContain("/api/v1/auth/oidc-auth/identities/ident-1");
		expect(paths).not.toContain(
			"/api/v1/auth/token-auth/identities/ident-1/tokens",
		);
		expect(result).toMatchObject({
			kind: "ready",
			auth: "oidc",
			token: undefined,
		});
	});

	it("never tells the owner to create anything, set env vars or use a terminal", async () => {
		lines.length = 0;
		await provisionInfisicalAccess(
			base(fakeMachine({ cliOnPath: true, signedIn: false }), fakeInfisical()),
		);
		for (const line of lines) {
			expect(line).not.toMatch(
				/\b(create|issue|generate)\b[^.]{0,80}\b(identity|token)\b/iu,
			);
			expect(line).not.toMatch(/environment variable|terminal/iu);
		}
	});
});

// R8  A remote box signs in with no inbound connection and no tunnel:
//     Infisical's sign-in returns its session to 127.0.0.1 on the owner's
//     own machine; when nothing listens there, Infisical shows "Unable to
//     reach CLI" with the session to copy. The owner opens the link, signs in
//     (SSO and MFA as their organization requires), and hands that value to
//     HoBo through the owner channel; HoBo uses the session inside it for the
//     API. The run needs no CLI for this, and installs none.
describe("SPEC R8: a remote box signs in through the owner channel", () => {
	const loginBlob = Buffer.from(
		JSON.stringify({
			JTWToken: USER_JWT,
			email: "owner@example.com",
			privateKey: "",
		}),
	).toString("base64");

	function channel(answer: string | undefined) {
		const opened: { url: string; message: string }[] = [];
		const asked: string[] = [];
		return {
			opened,
			asked,
			channel: {
				openUrl: async (url: string, message: string) => {
					opened.push({ url, message });
				},
				captureSecret: async (request: {
					name: string;
					title: string;
					instructions: string;
				}) => {
					asked.push(request.instructions);
					return answer;
				},
				holds: () => answer !== undefined,
			},
		};
	}

	it("opens Infisical's sign-in, takes the copied session, and provisions through the API", async () => {
		lines.length = 0;
		const owner = channel(loginBlob);
		const machine = fakeMachine({});
		const api = fakeInfisical();
		const result = await provisionInfisicalAccess({
			...base(machine, api),
			interactive: false,
			owner: owner.channel,
		});
		expect(owner.opened).toHaveLength(1);
		expect(owner.opened[0]?.url).toMatch(
			/^https:\/\/app\.infisical\.com\/login\?callback_port=\d+$/u,
		);
		expect(owner.asked).toHaveLength(1);
		expect(owner.asked[0]).toMatch(/Copy to clipboard/u);
		// No CLI, no install, no tunnel: the API does the rest.
		expect(machine.ran).toEqual([]);
		expect(api.calls.every((c) => c.auth === `Bearer ${USER_JWT}`)).toBe(true);
		expect(result).toMatchObject({
			kind: "ready",
			identityId: "ident-1",
			token: "identity-token",
		});
		// The session never reaches the owner-facing output.
		expect(lines.join("\n")).not.toContain(USER_JWT);
	});

	it("uses an existing CLI session on the box first, asking nothing", async () => {
		const owner = channel(loginBlob);
		const result = await provisionInfisicalAccess({
			...base(
				fakeMachine({ cliOnPath: true, signedIn: true }),
				fakeInfisical(),
			),
			interactive: false,
			owner: owner.channel,
		});
		expect(result.kind).toBe("ready");
		expect(owner.opened).toEqual([]);
		expect(owner.asked).toEqual([]);
	});

	it("refuses a value that is not Infisical's session, and asks again on the next run", async () => {
		const owner = channel("not-a-session");
		const result = await provisionInfisicalAccess({
			...base(fakeMachine({}), fakeInfisical()),
			interactive: false,
			owner: owner.channel,
		});
		// Asked again at once: the refusal carries a fresh sign-in link.
		expect(result).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_INFISICAL_SIGN_IN",
		});
		if (result.kind === "refused") {
			expect(result.message).not.toContain("not-a-session");
			expect(result.remediation[0]).toMatch(/^HOBO_OWNER_SIGN_IN url=/u);
		}
	});

	it("records nothing when the owner does not answer", async () => {
		const api = fakeInfisical();
		const result = await provisionInfisicalAccess({
			...base(fakeMachine({}), api),
			interactive: false,
			owner: channel(undefined).channel,
		});
		expect(result).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_INFISICAL_SIGN_IN",
		});
		expect(api.calls).toEqual([]);
		// The refusal carries the link and the capture that hands its result back.
		if (result.kind === "refused")
			expect(result.remediation[0]).toMatch(
				/^HOBO_OWNER_SIGN_IN url=https:\/\/app\.infisical\.com\/login\?callback_port=\d+ capture=INFISICAL_CLI_SESSION$/u,
			);
	});
});

describe("SPEC R9: HoBo resolves its own project and environment", () => {
	const folder = { environment: "prod", path: "/hobo-cd" };
	const signedIn = () => fakeMachine({ cliOnPath: true, signedIn: true });
	const said = (
		result: Awaited<ReturnType<typeof provisionInfisicalAccess>>,
	) =>
		result.kind === "refused"
			? [result.message, ...result.remediation].join("\n")
			: "";

	it("passes over an Agent Vault project for the one Secrets Management project", async () => {
		const api = fakeInfisical([
			{
				id: PROJECT,
				name: "agents",
				slug: "agents",
				type: "agent-vault",
				environments: [env("prod")],
			},
			secretsProject("proj-sm", "secrets", ["dev", "prod"]),
		]);
		const result = await provisionInfisicalAccess({
			...base(signedIn(), api),
			folder,
		});
		expect(result).toMatchObject({
			kind: "ready",
			projectId: "proj-sm",
			environment: "prod",
		});
		expect(api.calls.find((c) => c.path === "/api/v1/projects")?.query).toBe(
			"?type=secret-manager",
		);
		const folderCalls = api.calls.filter((c) => c.path === "/api/v1/folders");
		expect(folderCalls.length).toBeGreaterThan(0);
		for (const call of folderCalls.filter((c) => c.method === "GET")) {
			const query = new URLSearchParams(call.query);
			expect(query.get("workspaceId")).toBe("proj-sm");
			expect(query.get("environment")).toBe("prod");
		}
		expect(api.folders).toEqual([
			{ project: "proj-sm", environment: "prod", path: "/hobo-cd" },
		]);
		expect(
			api.calls.some((c) =>
				c.path.startsWith(`/api/v1/projects/${PROJECT}/memberships`),
			),
		).toBe(false);
		expect(api.calls.map((c) => `${c.method} ${c.path}`)).toContain(
			"POST /api/v1/projects/proj-sm/memberships/identities/ident-1",
		);
	});

	it("uses production where the project has no prod environment", async () => {
		const api = fakeInfisical([
			secretsProject(PROJECT, "secrets", ["dev", "production"]),
		]);
		const result = await provisionInfisicalAccess({
			...base(signedIn(), api),
			folder,
		});
		expect(result).toMatchObject({
			kind: "ready",
			projectId: PROJECT,
			environment: "production",
		});
		expect(api.folders).toEqual([
			{ project: PROJECT, environment: "production", path: "/hobo-cd" },
		]);
		expect(api.calls.some((c) => c.path.endsWith("/environments"))).toBe(false);
	});

	it("creates a prod environment where the project has none it can use", async () => {
		const api = fakeInfisical([secretsProject(PROJECT, "secrets", ["qa"])]);
		const result = await provisionInfisicalAccess({
			...base(signedIn(), api),
			folder,
		});
		expect(result).toMatchObject({ kind: "ready", environment: "prod" });
		expect(
			api.calls.find(
				(c) => c.path === `/api/v1/projects/${PROJECT}/environments`,
			)?.body,
		).toEqual({ name: "Production", slug: "prod" });
	});

	it("creates its own hobo project where there is no Secrets Management project", async () => {
		const api = fakeInfisical([]);
		const result = await provisionInfisicalAccess({
			...base(signedIn(), api),
			projectId: undefined,
			folder,
		});
		expect(
			api.calls.find(
				(c) => c.method === "POST" && c.path === "/api/v1/projects",
			)?.body,
		).toEqual({
			projectName: "hobo",
			slug: "hobo",
			type: "secret-manager",
			shouldCreateDefaultEnvs: true,
		});
		expect(result).toMatchObject({
			kind: "ready",
			projectId: "proj-made",
			environment: "prod",
		});
		expect(api.folders).toEqual([
			{ project: "proj-made", environment: "prod", path: "/hobo-cd" },
		]);
	});

	it("prefers the project named hobo among several", async () => {
		const api = fakeInfisical([
			secretsProject("proj-a", "billing"),
			secretsProject("proj-h", "HoBo"),
		]);
		const result = await provisionInfisicalAccess({
			...base(signedIn(), api),
			projectId: "missing-project",
			folder,
		});
		expect(result).toMatchObject({ kind: "ready", projectId: "proj-h" });
	});

	it("refuses several projects with none named hobo, naming them without ids", async () => {
		const api = fakeInfisical([
			{
				...secretsProject("proj-a", "billing"),
				id: "1f0c2a4e-1111-4a6b-9c3d-0e8f7a6b5c4d",
			},
			{
				...secretsProject("proj-b", "payments"),
				id: "2f0c2a4e-2222-4a6b-9c3d-0e8f7a6b5c4d",
			},
		]);
		const result = await provisionInfisicalAccess({
			...base(signedIn(), api),
			folder,
		});
		expect(result).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_INFISICAL_PROJECT_AMBIGUOUS",
		});
		const text = said(result);
		expect(text).toContain("billing");
		expect(text).toContain("payments");
		expect(text).not.toMatch(/1f0c2a4e|2f0c2a4e|proj-1/u);
		expect(api.calls.some((c) => c.method === "POST")).toBe(false);
	});

	const billingProjectId = "00000000-0000-4000-8000-000000000001";
	const paymentsProjectId = "00000000-0000-4000-8000-000000000002";
	const ambiguous = () =>
		fakeInfisical([
			{
				...secretsProject("proj-a", "billing"),
				id: billingProjectId,
			},
			{
				...secretsProject("proj-b", "payments"),
				id: paymentsProjectId,
			},
		]);
	const choosing = (answer: string | null | undefined) => {
		const asked: {
			message: string;
			title: string;
			options: readonly string[];
		}[] = [];
		return {
			asked,
			owner: {
				openUrl: async () => {},
				captureSecret: async () => undefined,
				holds: () => false,
				choose: async (request: {
					message: string;
					title: string;
					options: readonly string[];
				}) => {
					asked.push(request);
					return answer;
				},
			},
		};
	};

	it("asks the owner which project when several have none named hobo, by name only", async () => {
		const owner = choosing("payments");
		const result = await provisionInfisicalAccess({
			...base(signedIn(), ambiguous()),
			owner: owner.owner,
			folder,
		});
		expect(result).toMatchObject({
			kind: "ready",
			projectId: paymentsProjectId,
		});
		expect(owner.asked).toEqual([
			expect.objectContaining({
				title: "Infisical project",
				options: ["billing", "payments"],
			}),
		]);
		const asked = JSON.stringify(owner.asked);
		expect(asked).not.toContain(billingProjectId);
		expect(asked).not.toContain(paymentsProjectId);
		expect(asked).not.toMatch(/proj-/u);
	});

	it("refuses as before when the owner declines the choice or the host shows no form", async () => {
		for (const answer of [null, undefined]) {
			const result = await provisionInfisicalAccess({
				...base(signedIn(), ambiguous()),
				owner: choosing(answer).owner,
				folder,
			});
			expect(result).toMatchObject({
				kind: "refused",
				code: "HOBO_CD_INFISICAL_PROJECT_AMBIGUOUS",
			});
		}
	});

	it("does not offer a choice between projects that share a name", async () => {
		const owner = choosing("billing");
		const result = await provisionInfisicalAccess({
			...base(
				signedIn(),
				fakeInfisical([
					{
						...secretsProject("proj-a", "billing"),
						id: billingProjectId,
					},
					{
						...secretsProject("proj-b", "billing"),
						id: paymentsProjectId,
					},
				]),
			),
			owner: owner.owner,
			folder,
		});
		expect(result).toMatchObject({ kind: "refused" });
		expect(owner.asked).toEqual([]);
	});

	it("never repeats an id Infisical quotes in a refusal", async () => {
		const id = "3f0c2a4e-3333-4a6b-9c3d-0e8f7a6b5c4d";
		const api = fakeInfisical([secretsProject(id, "secrets")]);
		const refusing: typeof fetch = async (input, init) =>
			new URL(String(input)).pathname === "/api/v1/folders"
				? Response.json(
						{ message: `Project with ${id} not found` },
						{ status: 404 },
					)
				: api.fetch(input, init);
		const result = await provisionInfisicalAccess({
			...base(signedIn(), api),
			projectId: id,
			fetch: refusing,
			folder,
		});
		expect(result).toMatchObject({ kind: "refused" });
		const text = said(result);
		expect(text).toContain("Infisical refused listing the folders in /");
		expect(text).not.toContain(id);
		expect(text).not.toContain("3f0c2a4e");
	});
});
