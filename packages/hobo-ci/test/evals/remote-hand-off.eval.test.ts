import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createGithubAppManifest } from "@hobo/ci-gh-actions";
import type { CommandRunInput, PrepareInput, PrepareOutcome } from "@hobo/cli";
import { createTrustedVault } from "@hobo/core";
import { createMemorySecretsPort, type SecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import {
	type OpenedSecretStore,
	OWNER_CREDENTIAL_LINE_PREFIX,
	prepareGithubConnection,
	type SecretStoreOpening,
} from "../../src/index.js";

// EVAL (CI half; the CD half is packages/hobo-cd/test/evals): an agent runs `hobo ci up` / `hobo cd up` in a remote managed box the
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

// The GitHub App the relay already runs, in the relay's folder: CI reuses it.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
	modulusLength: 2048,
});
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PACT: {
	readonly interactions: readonly {
		readonly request: { readonly method: string; readonly path: string };
		readonly response: { readonly status: number; readonly body: object };
	}[];
} = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL(
				"../../contracts/pacts/github-app-manifest.pact.json",
				import.meta.url,
			),
		),
		"utf8",
	),
);

const reviewed = createGithubAppManifest({
	name: "HoBo CI",
	relayUrl: "https://ci.hobo.example",
	manifestCallbackUrl: "https://ci.hobo.example/v1/app-bootstrap/callback",
	installationCallbackUrl:
		"https://ci.hobo.example/v1/app-registration/install-callback",
});

function github(): typeof fetch {
	return async (input, init) => {
		const url = new URL(String(input));
		const call = `${init?.method ?? "GET"} ${url.pathname}`;
		if (call.startsWith("GET /app")) {
			const parts =
				new Headers(init?.headers)
					.get("authorization")
					?.replace(/^Bearer /u, "")
					.split(".") ?? [];
			if (
				parts.length !== 3 ||
				!createVerify("RSA-SHA256")
					.update(`${parts[0]}.${parts[1]}`)
					.verify(publicKey, Buffer.from(parts[2] ?? "", "base64url"))
			)
				return new Response(null, { status: 401 });
		}
		const match = PACT.interactions.find(
			(i) => `${i.request.method} ${i.request.path}` === call,
		);
		if (match === undefined) return new Response("{}", { status: 404 });
		const body = {
			...match.response.body,
			...("owner" in match.response.body
				? {
						owner: { id: 4242, type: "User" },
						permissions: reviewed.defaultPermissions,
						events: reviewed.defaultEvents,
					}
				: undefined),
		};
		return Response.json(body, { status: match.response.status });
	};
}

describe("EVAL remote box: hobo ci up --hand-off", () => {
	it("completes from outside with the relay's App, once the credential posts back", async () => {
		const session = remoteSession();
		const owner = ownerOutside({
			session,
			approveDevice: () => undefined,
			acts: true,
		});
		const store = storeOpener(session);
		const seed = {
			HOBO_CI_GITHUB_APP_PRIVATE_KEY: PEM,
			HOBO_CI_WEBHOOK_SECRET: "whsec",
			HOBO_CI_GITHUB_APP_CLIENT_SECRET: "client-secret",
			HOBO_CI_GITHUB_APP_CLIENT_ID: "Iv1.test",
			HOBO_CI_GITHUB_APP_ID: "777",
			HOBO_CI_SETTINGS: JSON.stringify({
				HOBO_CI_PUBLIC_URL: "https://ci.hobo.example",
				HOBO_CI_GITHUB_OWNER: "octo",
			}),
		};
		for (const [name, value] of Object.entries(seed))
			await store.port.put(name, value);
		const outcome = await prepareGithubConnection(handOffInput(owner.see), {
			env: {
				HOBO_CI_GITHUB_OWNER_ID: "4242",
				HOBO_CI_GITHUB_OWNER_TYPE: "User",
			},
			vault: createTrustedVault(),
			locator: LOCATOR,
			openStore: store.open,
			fetch: github(),
			sleep: async () => undefined,
			startPage: noPage,
		});
		if (outcome.kind !== "ready")
			throw new Error(`refused: ${JSON.stringify(outcome)}`);
		expect(outcome).toMatchObject({
			steps: [{ id: "github-app", outcome: "unchanged" }],
		});
		expect(
			owner.shown.some((l) => l.startsWith(OWNER_CREDENTIAL_LINE_PREFIX)),
		).toBe(true);
		expectNoLoopback(ownerFacingText(owner.shown, outcome));
	});

	it("without an App or an owner channel, names the HoBo MCP route, never a terminal or a broker", async () => {
		const session = remoteSession();
		const owner = ownerOutside({
			session,
			approveDevice: () => undefined,
			acts: true,
		});
		const outcome = await prepareGithubConnection(handOffInput(owner.see), {
			env: {},
			vault: createTrustedVault(),
			locator: LOCATOR,
			openStore: storeOpener(session).open,
			sleep: async () => undefined,
			startPage: noPage,
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CI_APP_NEEDS_OWNER" },
		});
		const text = ownerFacingText(owner.shown, outcome);
		expectNoLoopback(text);
		expect(text.join("\n")).toContain("through the HoBo MCP server");
		expect(text.join("\n")).not.toMatch(/terminal/u);
		expect(text.join("\n")).not.toContain("--via-workflow");
		expect(text.join("\n")).not.toMatch(/relay/u);
	});
});
