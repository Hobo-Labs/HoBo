import type { CommandRunInput, PrepareInput, PrepareOutcome } from "@hobo/cli";
import {
	type OpenedSecretStore,
	OWNER_CREDENTIAL_LINE_PREFIX,
	type SecretStoreOpening,
} from "@hobo/hobo-ci";
import { createMemorySecretsPort, type SecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	OWNER_DEVICE_LINE_PREFIX,
	prepareVercelConnection,
	VERCEL_DEVICE_AUTHORIZATION_URL,
	VERCEL_DEVICE_TOKEN_URL,
} from "../../src/index.js";

// EVAL: an agent runs `hobo ci up` / `hobo cd up` in a remote managed box the
// owner cannot reach. The owner is outside: they can open public HTTPS pages,
// type a credential into the agent session's credential form (its egress
// proxy then injects it into the box's requests to that host), and approve a
// device code on the provider's site. Nothing reaches back into the box.
//
// Each scenario holds the run to:
//   1. Hand-off: every line the owner is shown names something they can do
//      from outside (no 127.0.0.1 or localhost, no page served in the box).
//   2. Post-back: what the owner does outside reaches the same run, which
//      finishes without being restarted and without an inbound connection.
//   3. A dead end is never silent: if the owner does nothing, the run refuses
//      with ways forward the owner can take from outside.

const LOOPBACK = /\b(127\.0\.0\.1|localhost|\[::1\])\b/iu;
const STORE_HOST = "app.infisical.com";
const OWNER_TOKEN = "owner-token-from-the-credential-form";

/** The agent's remote session: the credential form and its egress proxy. */
function remoteSession() {
	const saved = new Map<string, string>();
	return {
		/** The owner types a credential into the session's form. */
		save(host: string, token: string) {
			saved.set(host, token);
		},
		/** What the proxy injects for `host`, if the owner saved one. */
		injected: (host: string) => saved.get(host),
	};
}

/**
 * Infisical as the box reaches it: through the proxy. A read is answered
 * only once the owner's token is injected; the run's placeholder is refused.
 */
function infisicalThroughProxy(
	session: ReturnType<typeof remoteSession>,
	port: SecretsPort,
): SecretsPort {
	const authorized = () => session.injected(STORE_HOST) === OWNER_TOKEN;
	const denied = {
		status: "denied",
		reason: "401 from Infisical",
		code: "unauthenticated",
	} as const;
	return {
		id: port.id,
		kind: port.kind,
		async access(name) {
			return authorized() ? port.access(name) : denied;
		},
		async accessVersion(name, versionId) {
			return authorized() ? port.accessVersion(name, versionId) : denied;
		},
		async listVersions(name) {
			if (!authorized()) throw new Error("401 from Infisical");
			return port.listVersions(name);
		},
		async put(name, value) {
			if (!authorized()) throw new Error("401 from Infisical");
			return port.put(name, value);
		},
	};
}

/** The owner, outside the box: acts only on what they can reach. */
function ownerOutside(options: {
	readonly session: ReturnType<typeof remoteSession>;
	readonly approveDevice: (code: string) => void;
	readonly acts: boolean;
}) {
	const shown: string[] = [];
	return {
		shown,
		see(line: string) {
			shown.push(line);
			if (!options.acts) return;
			if (line.startsWith(OWNER_CREDENTIAL_LINE_PREFIX)) {
				const guide = /guide=(\S+)/u.exec(line)?.[1] ?? "";
				expect(new URL(guide).protocol).toBe("https:");
				// They follow the steps on infisical.com, then type the token
				// into the session's form: never into the chat.
				options.session.save(STORE_HOST, OWNER_TOKEN);
			}
			if (line.startsWith(OWNER_DEVICE_LINE_PREFIX)) {
				const link = new URL(line.split(" ")[1] ?? "");
				expect(link.protocol).toBe("https:");
				expect(link.hostname).toBe("vercel.com");
				options.approveDevice(/code=(\S+)/u.exec(line)?.[1] ?? "");
			}
		},
	};
}

function handOffInput(see: (line: string) => void): PrepareInput {
	const run: Pick<CommandRunInput, "emitProgress" | "flags"> = {
		emitProgress: see,
		// SAFETY: the preparation reads only progress and these output flags.
		flags: { json: false, quiet: false } as CommandRunInput["flags"],
	};
	// SAFETY: the preparation reads only progress and these output flags.
	return {
		action: "up",
		projectDir: "/box/project",
		whatIf: false,
		yes: false,
		handOff: true,
		run: run as CommandRunInput,
	};
}

/** Everything the owner was shown, and the run's own words if it refused. */
function ownerFacingText(shown: readonly string[], outcome: PrepareOutcome) {
	return [
		...shown,
		...(outcome.kind === "refused"
			? [outcome.result.message, ...(outcome.result.remediation ?? [])]
			: []),
	];
}

function expectNoLoopback(lines: readonly string[]) {
	for (const line of lines) expect(line).not.toMatch(LOOPBACK);
}

const noPage = () => {
	throw new Error("a handed-off run must serve no page in the box");
};

/** The box's store: opened from the committed locator, signed in by proxy. */
function storeOpener(session: ReturnType<typeof remoteSession>) {
	const port = createMemorySecretsPort({ id: "memory" });
	const store: OpenedSecretStore = {
		id: "infisical",
		port: infisicalThroughProxy(session, port),
		reference: (name) => `infisical://proj/prod/folder/${name}`,
	};
	const signIns: string[] = [];
	return {
		port,
		signIns,
		open: async (
			_id: string,
			coordinates: Readonly<Record<string, string | undefined>>,
		): Promise<SecretStoreOpening> => {
			signIns.push(coordinates.INFISICAL_SIGN_IN ?? "none");
			return { ok: true, store };
		},
	};
}

// The owner chose to sign this run in through the session's egress proxy
// (an explicit choice; by default HoBo provisions its own Infisical access).
const LOCATOR = {
	read: async () => ({
		HOBO_SECRET_STORE: "infisical",
		INFISICAL_PROJECT_ID: "proj",
		INFISICAL_SIGN_IN: "egress-proxy",
	}),
	write: async () => undefined,
};

/** Vercel's device grant: approved once the owner enters the code. */
function vercel() {
	let approved = false;
	const issuedCode = "WXYZ-1234";
	const http = async (input: string | URL | Request) => {
		const url = String(input);
		if (url === VERCEL_DEVICE_AUTHORIZATION_URL)
			return Response.json({
				device_code: "device-code",
				user_code: issuedCode,
				verification_uri: "https://vercel.com/device",
				verification_uri_complete: `https://vercel.com/device?user_code=${issuedCode}`,
				expires_in: 600,
				interval: 5,
			});
		if (url === VERCEL_DEVICE_TOKEN_URL)
			return approved
				? Response.json({ access_token: "vercel-token" })
				: Response.json({ error: "authorization_pending" }, { status: 400 });
		if (url.startsWith("https://api.vercel.com/v2/teams"))
			return Response.json({
				teams: [{ id: "team_abc", slug: "acme" }],
				pagination: { next: null },
			});
		return new Response("{}", { status: 404 });
	};
	return {
		http,
		approve(code: string) {
			if (code === issuedCode) approved = true;
		},
	};
}

describe("EVAL remote box: hobo cd up --hand-off", () => {
	it("does not switch a saved OAuth choice to the egress proxy", async () => {
		const lines: string[] = [];
		let sleeps = 0;
		const outcome = await prepareVercelConnection(
			handOffInput((line) => lines.push(line)),
			{
				env: {},
				locator: {
					read: async () => ({
						HOBO_SECRET_STORE: "infisical",
						INFISICAL_PROJECT_ID: "proj",
						INFISICAL_SIGN_IN: "oauth",
						INFISICAL_OAUTH_CLIENT_ID: "client-id",
					}),
					write: async () => undefined,
				},
				openStore: async () => {
					throw new Error("OAuth credentials are missing");
				},
				sleep: async () => {
					sleeps += 1;
				},
				handOffTimeoutMs: 1,
				startPage: noPage,
			},
		);
		expect(sleeps).toBe(0);
		expect(
			lines.some((line) => line.startsWith(OWNER_CREDENTIAL_LINE_PREFIX)),
		).toBe(false);
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CD_STORE_NEEDS_SIGN_IN" },
		});
	});

	it("completes from outside: the credential and the device code post back into the same run", async () => {
		const session = remoteSession();
		const provider = vercel();
		const owner = ownerOutside({
			session,
			approveDevice: provider.approve,
			acts: true,
		});
		const store = storeOpener(session);
		const outcome = await prepareVercelConnection(handOffInput(owner.see), {
			env: {},
			locator: LOCATOR,
			openStore: store.open,
			fetch: provider.http,
			sleep: async () => undefined,
			startPage: noPage,
		});
		if (outcome.kind !== "ready")
			throw new Error(`refused: ${JSON.stringify(outcome)}`);
		// Post-back reached the box: the store answered with the owner's
		// token and holds the connection the device grant produced.
		expect(store.signIns.every((mode) => mode === "egress-proxy")).toBe(true);
		expect(
			(await store.port.access("HOBO_CD_VERCEL_INSTALLATION_ID")).status,
		).toBe("ok");
		expect(outcome.credentials?.reveal("VERCEL_TOKEN")).toBe("vercel-token");
		// Hand-off: the owner was asked for exactly the two outside actions.
		expect(owner.shown.map((line) => line.split(" ")[0])).toEqual(
			expect.arrayContaining([
				OWNER_CREDENTIAL_LINE_PREFIX,
				OWNER_DEVICE_LINE_PREFIX,
			]),
		);
		expectNoLoopback(ownerFacingText(owner.shown, outcome));
		expect(owner.shown.join("\n")).not.toContain("vercel-token");
	});

	it("refuses with outside paths, never a loopback page, when the owner does nothing", async () => {
		const session = remoteSession();
		const owner = ownerOutside({
			session,
			approveDevice: () => undefined,
			acts: false,
		});
		const outcome = await prepareVercelConnection(handOffInput(owner.see), {
			env: {},
			locator: LOCATOR,
			openStore: storeOpener(session).open,
			fetch: vercel().http,
			sleep: async () => undefined,
			handOffTimeoutMs: 50,
			startPage: noPage,
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CD_STORE_NEEDS_SIGN_IN" },
		});
		const text = ownerFacingText(owner.shown, outcome);
		expectNoLoopback(text);
		expect(text.join("\n")).toContain("credential form");
	});
});
