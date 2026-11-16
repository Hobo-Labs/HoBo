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

/** Infisical's API as the run reaches it, recording what was created. */
function fakeInfisical() {
	const calls: { method: string; path: string; body: unknown; auth: string }[] =
		[];
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		const auth = new Headers(init?.headers).get("authorization") ?? "";
		calls.push({
			method: init?.method ?? "GET",
			path: url.pathname,
			body,
			auth,
		});
		if (auth !== `Bearer ${USER_JWT}`)
			return Response.json({ message: "unauthorized" }, { status: 401 });
		if (url.pathname === "/api/v1/identities")
			return Response.json({ identity: { id: "ident-1", name: body.name } });
		if (url.pathname === "/api/v1/auth/token-auth/identities/ident-1")
			return Response.json({ identityTokenAuth: { id: "ta-1" } });
		if (url.pathname === "/api/v1/auth/oidc-auth/identities/ident-1")
			return Response.json({ identityOidcAuth: { id: "oa-1" } });
		if (url.pathname === "/api/v1/auth/token-auth/identities/ident-1/tokens")
			return Response.json({ accessToken: "identity-token", expiresIn: 3600 });
		if (
			url.pathname ===
			`/api/v1/projects/${PROJECT}/memberships/identities/ident-1`
		)
			return Response.json({ identityMembership: { id: "m-1" } });
		return Response.json({ message: "not found" }, { status: 404 });
	};
	return { calls, fetch: fetchImpl };
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
			"POST /api/v1/identities",
			"POST /api/v1/auth/token-auth/identities/ident-1",
			`POST /api/v1/projects/${PROJECT}/memberships/identities/ident-1`,
			"POST /api/v1/auth/token-auth/identities/ident-1/tokens",
		]);
		expect(api.calls[0]?.body).toMatchObject({
			organizationId: ORG,
			role: "no-access",
		});
		expect(result).toMatchObject({
			kind: "ready",
			identityId: "ident-1",
			auth: "token",
			token: "identity-token",
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
