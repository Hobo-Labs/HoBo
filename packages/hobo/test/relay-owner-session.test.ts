import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHoboCli } from "@hobo/cli";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import pact from "../contracts/relay-owner-login.pact.json";
import type { JsonObject } from "../src/json.js";
import { createBrokerAwareLoginCommand } from "../src/login-command.js";
import { createRelayLoginTool } from "../src/mcp-relay-login.js";
import { createStoreChoiceApp } from "../src/mcp-store-choice.js";
import {
	OwnerCredentialUnavailable,
	type OwnerStoreSessions,
	withRelaySession,
} from "../src/owner-store-session.js";
import {
	createRelayOwnerSessions,
	parseRelayOrigin,
	type RelayConfirmation,
	relayCredentialsOnDemand,
	relayFlagOf,
	relayOnlyOwnerSession,
	withoutRelayFlag,
} from "../src/relay-owner-session.js";

const ORIGIN = "https://relay.example";
const SESSION = "S".repeat(52);
const DEVICE = "D".repeat(52);
const ACCOUNT = "C".repeat(52);
const INSTALLATION = "ghs_installation_token_for_org_repo";
const SECRETS = [SESSION, DEVICE, ACCOUNT, INSTALLATION, "ABCD-EFGH", ORIGIN];

const Interaction = z.object({
	description: z.string(),
	providerState: z.string(),
	request: z.object({
		method: z.literal("POST"),
		path: z.string(),
		headers: z.record(z.string(), z.string()),
		body: z.record(z.string(), z.json()),
	}),
	response: z.object({
		status: z.number(),
		headers: z.record(z.string(), z.string()),
		body: z.record(z.string(), z.json()),
	}),
});
const interactions = z.array(Interaction).parse(pact.interactions);

function interaction(description: string) {
	const found = interactions.find((entry) => entry.description === description);
	if (found === undefined) throw new Error(`no interaction ${description}`);
	return found;
}

type Seen = { path: string; headers: Headers; body: string };

function pactRelay() {
	const seen: Seen[] = [];
	let confirmed = false;
	let expired = false;
	const replay = (description: string) => {
		const { response } = interaction(description);
		return Response.json(response.body, {
			status: response.status,
			headers: response.headers,
		});
	};
	const fetch = async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
		const body = String(init?.body ?? "");
		seen.push({ path: url.pathname, headers, body });
		if (url.origin !== ORIGIN) throw new Error(`unexpected ${url.origin}`);
		if (url.pathname === "/v1/owner-login/device")
			return replay("start the owner's device sign-in");
		if (url.pathname === "/v1/owner-login/token")
			return replay(
				confirmed
					? "poll once the owner confirmed"
					: "poll before the owner confirmed",
			);
		const ref = z.object({ ref: z.string() }).parse(JSON.parse(body)).ref;
		if (expired) return replay("refuse a credential once the session expired");
		if (ref === "github-app://Org/Repo")
			return replay("resolve a GitHub App installation token");
		if (ref === "owner://HOBO_CI_ACCOUNT_TOKEN")
			return replay("resolve the CI account credential");
		return replay("refuse a long-lived store entry");
	};
	return {
		fetch,
		seen,
		confirm: () => {
			confirmed = true;
		},
		expire: () => {
			expired = true;
		},
	};
}

function clock() {
	let now = 1_800_000_000_000;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

function relayDeps(relay: ReturnType<typeof pactRelay>, time = clock()) {
	let polls = 0;
	return {
		time,
		deps: {
			fetch: relay.fetch,
			now: time.now,
			sleep: async (ms: number) => {
				time.advance(ms);
				polls += 1;
				if (polls === 2) relay.confirm();
			},
		},
	};
}

function expectRequestsMatchPact(seen: readonly Seen[]) {
	for (const request of seen) {
		const body = JSON.parse(request.body);
		const declared = interactions.filter(
			(entry) =>
				entry.request.path === request.path &&
				JSON.stringify(entry.request.body) === JSON.stringify(body) &&
				Object.entries(entry.request.headers).every(
					([name, value]) => request.headers.get(name) === value,
				),
		);
		expect(declared.length, `${request.path} ${request.body}`).toBeGreaterThan(
			0,
		);
	}
}

describe("HoBo's relay sign-in, against the relay's contract", () => {
	it("confirms once, holds the session in memory, and resolves what the relay hands out", async () => {
		const relay = pactRelay();
		const { deps } = relayDeps(relay);
		const sessions = createRelayOwnerSessions(deps);
		const shown: RelayConfirmation[] = [];
		const session = await sessions.begin({
			origin: parseRelayOrigin(ORIGIN),
			present: async (confirmation) => {
				shown.push(confirmation);
			},
		});
		expect(shown).toEqual([
			{
				verificationUri: "https://github.com/login/device",
				userCode: "ABCD-EFGH",
				expiresInSeconds: 900,
			},
		]);
		expect(sessions.state()).toMatchObject({ status: "established" });
		expect(JSON.stringify(session)).not.toContain(SESSION);
		expect(
			await session.credentials.resolve(
				"github-app://Org/Repo",
				"hobo ci status",
			),
		).toEqual({ token: INSTALLATION });
		expect(
			await session.credentials.resolve(
				"owner://HOBO_CI_ACCOUNT_TOKEN",
				"hobo ci status",
			),
		).toEqual({ token: ACCOUNT });
		await expect(
			session.credentials.resolve(
				"owner://HOSTINGER_API_TOKEN",
				"hobo ci fleet",
			),
		).rejects.toMatchObject({ reason: "relay-not-resolvable" });
		relay.expire();
		await expect(
			session.credentials.resolve("github-app://Org/Repo", "hobo ci status"),
		).rejects.toMatchObject({ reason: "relay-session-expired" });
		expectRequestsMatchPact(relay.seen);
		expect(
			relay.seen.filter((request) => request.path === "/v1/owner-login/token"),
		).toHaveLength(2);
	});

	it("ends the session when it expires, without asking the relay", async () => {
		const relay = pactRelay();
		const { deps, time } = relayDeps(relay);
		const sessions = createRelayOwnerSessions(deps);
		const session = await sessions.begin({
			origin: parseRelayOrigin(ORIGIN),
			present: async () => undefined,
		});
		time.advance(28_800_000);
		expect(sessions.held()).toBeUndefined();
		expect(sessions.state()).toEqual({ status: "none" });
		const before = relay.seen.length;
		await expect(
			session.credentials.resolve("github-app://Org/Repo", "s"),
		).rejects.toMatchObject({ reason: "relay-session-expired" });
		expect(relay.seen).toHaveLength(before);
	});

	it("needs exactly one confirmation in a new process, and never a form", async () => {
		const relay = pactRelay();
		const { deps } = relayDeps(relay);
		const restarted = createRelayOwnerSessions(deps);
		expect(restarted.held()).toBeUndefined();
		let confirmations = 0;
		const resolver = relayCredentialsOnDemand({
			sessions: restarted,
			origin: parseRelayOrigin(ORIGIN),
			present: async () => {
				confirmations += 1;
			},
		});
		const [first, second] = await Promise.all([
			resolver.resolve("github-app://Org/Repo", "s"),
			resolver.resolve("owner://HOBO_CI_ACCOUNT_TOKEN", "s"),
		]);
		expect(first).toEqual({ token: INSTALLATION });
		expect(second).toEqual({ token: ACCOUNT });
		await resolver.resolve("github-app://Org/Repo", "s");
		expect(confirmations).toBe(1);
		expect(
			relay.seen.filter((request) => request.path === "/v1/owner-login/device"),
		).toHaveLength(1);
	});

	it("maps the relay's refusals of the sign-in to typed codes", async () => {
		for (const [error, code] of [
			["access_denied", "HOBO_RELAY_LOGIN_DENIED"],
			["expired_token", "HOBO_RELAY_LOGIN_EXPIRED"],
			["not_owner", "HOBO_RELAY_LOGIN_NOT_OWNER"],
		] as const) {
			const sessions = createRelayOwnerSessions({
				fetch: async (input) =>
					String(input).endsWith("/device")
						? Response.json(
								interaction("start the owner's device sign-in").response.body,
							)
						: Response.json(
								{ error },
								{ status: error === "not_owner" ? 403 : 400 },
							),
				sleep: async () => undefined,
				now: clock().now,
			});
			await expect(
				sessions.begin({
					origin: parseRelayOrigin(ORIGIN),
					present: async () => undefined,
				}),
			).rejects.toMatchObject({ code });
			expect(sessions.state()).toMatchObject({ status: "failed" });
		}
		const refused = createRelayOwnerSessions({
			fetch: async () =>
				Response.json({ error: "not_configured" }, { status: 409 }),
			sleep: async () => undefined,
			now: clock().now,
		});
		await expect(
			refused.begin({
				origin: parseRelayOrigin(ORIGIN),
				present: async () => undefined,
			}),
		).rejects.toMatchObject({ code: "HOBO_RELAY_LOGIN_NOT_CONFIGURED" });
	});
});

describe("refusals without a relay session", () => {
	const noStore: OwnerStoreSessions = {
		establish: async () => ({ status: "unchosen" }),
		status: () => ({ established: false }),
		credentials: (_cwd) => ({
			resolve: async (ref) => {
				throw new OwnerCredentialUnavailable(ref, "no-session");
			},
		}),
		entries: () => ({
			read: async () => undefined,
			write: async () => undefined,
		}),
		agentVault: () => undefined,
		close: async () => undefined,
	};

	it("keeps the store's refusal while no relay session is held", async () => {
		const sessions = withRelaySession(noStore, {
			held: () => undefined,
			now: Date.now,
		});
		await expect(
			sessions.credentials("/p").resolve("github-app://Org/Repo", "s"),
		).rejects.toMatchObject({ reason: "no-session" });
		expect(sessions.status("/p")).toEqual({ established: false });
	});

	it("routes to the relay session once one is held", async () => {
		const relay = pactRelay();
		const { deps } = relayDeps(relay);
		const held = createRelayOwnerSessions(deps);
		await held.begin({
			origin: parseRelayOrigin(ORIGIN),
			present: async () => undefined,
		});
		const sessions = withRelaySession(noStore, {
			held: () => held.held(),
			now: deps.now,
		});
		expect(
			await sessions.credentials("/p").resolve("github-app://Org/Repo", "s"),
		).toEqual({ token: INSTALLATION });
		expect(sessions.status("/p")).toEqual({
			established: false,
			relaySession: { expiresInSeconds: 28_800 },
		});
		await expect(
			sessions
				.credentials("/p")
				.resolve(["env:", "/", "/NPM_TOKEN"].join(""), "s"),
		).rejects.toMatchObject({ reason: "environment-ref" });
	});

	it("never reads or writes owner entries through a relay-only session", async () => {
		const sessions = createRelayOwnerSessions({
			fetch: async () => new Response(null, { status: 500 }),
			sleep: async () => undefined,
			now: Date.now,
		});
		const owner = relayOnlyOwnerSession({
			sessions,
			credentials: { resolve: async () => ({ token: "unused" }) },
		});
		await expect(
			owner.entries("/p").read("HOBO_CI_ACCOUNT_TOKEN"),
		).rejects.toThrow(OwnerCredentialUnavailable);
		expect(owner.agentVault("/p")).toBeUndefined();
	});

	it("reads --relay only from the arguments, and strips it for cd", () => {
		expect(relayFlagOf(["cd", "up", "--relay", ORIGIN])).toBe(ORIGIN);
		expect(relayFlagOf(["ci", `--relay=${ORIGIN}`])).toBe(ORIGIN);
		expect(relayFlagOf(["cd", "--", "--relay", ORIGIN])).toBeUndefined();
		expect(withoutRelayFlag(["cd", "up", "--relay", ORIGIN, "--json"])).toEqual(
			["cd", "up", "--json"],
		);
	});
});

const homes: string[] = [];
afterEach(async () => {
	await Promise.all(
		homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
	);
});

async function listing(root: string): Promise<string[]> {
	const entries = await readdir(root, { recursive: true });
	return entries.map(String).sort();
}

describe("hobo login --relay", () => {
	it("signs in for this process only and writes nothing under HOBO_HOME", async () => {
		const home = await mkdtemp(join(tmpdir(), "hobo-relay-login-"));
		homes.push(home);
		const before = await listing(home);
		const relay = pactRelay();
		const { deps } = relayDeps(relay);
		const sessions = createRelayOwnerSessions(deps);
		const opened: string[] = [];
		const cli = createHoboCli({
			commands: {
				login: createBrokerAwareLoginCommand({
					env: { HOBO_HOME: home },
					relay: { sessions, openBrowser: (url) => opened.push(url) },
				}),
			},
		});
		const result = await cli.run([
			"login",
			"--relay",
			ORIGIN,
			"--home",
			home,
			"--json",
		]);
		expect(result.exitCode).toBe(0);
		expect(sessions.held()).toBeDefined();
		expect(opened).toEqual(["https://github.com/login/device"]);
		expect(await listing(home)).toEqual(before);
		for (const secret of [SESSION, DEVICE, ACCOUNT, INSTALLATION])
			expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
		expect(result.stdout).not.toContain(ORIGIN);
	});

	it("refuses a non-https relay and points HoBo MCP at relay_login", async () => {
		const sessions = createRelayOwnerSessions({
			fetch: async () => new Response(null, { status: 500 }),
			sleep: async () => undefined,
			now: Date.now,
		});
		const local = createHoboCli({
			commands: {
				login: createBrokerAwareLoginCommand({ relay: { sessions } }),
			},
		});
		const insecure = await local.run([
			"login",
			"--relay",
			"http://relay.example",
			"--json",
		]);
		expect(insecure.exitCode).not.toBe(0);
		expect(insecure.stdout).toContain("HOBO_RELAY_LOGIN_ORIGIN");
		const mcp = createHoboCli({
			commands: {
				login: createBrokerAwareLoginCommand({ relay: "owner-channel" }),
			},
		});
		const viaMcp = await mcp.run(["login", "--relay", ORIGIN, "--json"]);
		expect(viaMcp.stdout).toContain("HOBO_RELAY_LOGIN_USE_MCP_TOOL");
	});
});

describe("HoBo MCP's relay_login", () => {
	const locator = () => ({ read: async () => ({}), write: async () => {} });

	it("asks the owner in host forms, confirms once, and returns only a status", async () => {
		const relay = pactRelay();
		const { deps } = relayDeps(relay);
		const sessions = createRelayOwnerSessions(deps);
		const app = createStoreChoiceApp({
			cwd: "/p",
			locatorFor: locator,
			relayLogin: createRelayLoginTool({
				relay: sessions,
				sleep: () => new Promise<void>(() => undefined),
			}),
		});
		const support = { formElicitation: true, apps: false };
		expect(app.tools(support).map((tool) => tool.name)).toContain(
			"relay_login",
		);
		const forms: string[] = [];
		const request = async (_method: string, params: JsonObject) => {
			forms.push(JSON.stringify(params));
			return forms.length === 1
				? { action: "accept", content: { relay: ORIGIN } }
				: { action: "accept", content: { confirmed: true } };
		};
		const result = await app.callTool("relay_login", {}, support, request);
		expect(result.structuredContent).toMatchObject({ status: "established" });
		expect(forms).toHaveLength(2);
		expect(forms[1]).toContain("ABCD-EFGH");
		for (const secret of SECRETS)
			expect(JSON.stringify(result)).not.toContain(secret);
		const again = await app.callTool("relay_login", {}, support, request);
		expect(again.structuredContent).toMatchObject({ status: "established" });
		expect(forms).toHaveLength(2);
	});

	it("refuses without a private owner channel", async () => {
		const app = createStoreChoiceApp({
			cwd: "/p",
			locatorFor: locator,
			relayLogin: createRelayLoginTool({
				relay: createRelayOwnerSessions({
					fetch: async () => new Response(null, { status: 500 }),
					sleep: async () => undefined,
					now: Date.now,
				}),
			}),
		});
		const result = await app.callTool(
			"relay_login",
			{},
			{ formElicitation: false, apps: false },
			undefined,
		);
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			status: "secure-form-unavailable",
		});
	});
});
