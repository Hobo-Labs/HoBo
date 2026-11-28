import type { CommandRunInput, PrepareInput, PrepareOutcome } from "@hobo/cli";
import {
	type OpenedSecretStore,
	OWNER_CAPTURE_LINE_PREFIX,
	type OwnerChannel,
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
import { fakeWorkload } from "../support/workload.js";

const LOOPBACK = /\b(127\.0\.0\.1|localhost|\[::1\])\b/iu;
const OWNER_TOKEN = "owner-token-from-hobo-capture";

function infisicalSignedInWith(
	token: string | undefined,
	port: SecretsPort,
): SecretsPort {
	const authorized = () => token === OWNER_TOKEN;
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

function heldChannel() {
	const held = new Map<string, string>();
	const channel: OwnerChannel & { deposit(name: string, value: string): void } =
		{
			openUrl: async () => undefined,
			captureSecret: async ({ name }) => {
				const value = held.get(name);
				held.delete(name);
				return value;
			},
			holds: (name) => held.has(name),
			deposit(name, value) {
				held.set(name, value);
			},
		};
	return channel;
}

function ownerOutside(options: {
	readonly approveDevice: (code: string) => void;
}) {
	const shown: string[] = [];
	return {
		shown,
		see(line: string) {
			shown.push(line);
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
		cwd: "/box/project",
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

function storeOpener() {
	const port = createMemorySecretsPort({ id: "memory" });
	const tokens: (string | undefined)[] = [];
	return {
		port,
		tokens,
		open: async (
			_id: string,
			_coordinates: Readonly<Record<string, string | undefined>>,
			signIn: { reveal(name: string): string | undefined },
		): Promise<SecretStoreOpening> => {
			const token = signIn.reveal("INFISICAL_TOKEN");
			tokens.push(token);
			const store: OpenedSecretStore = {
				id: "infisical",
				port: infisicalSignedInWith(token, port),
				reference: (name) => `infisical://proj/prod/folder/${name}`,
			};
			return { ok: true, store };
		},
	};
}

const LOCATOR = {
	read: async () => ({
		HOBO_SECRET_STORE: "infisical",
		INFISICAL_PROJECT_ID: "proj",
		INFISICAL_SIGN_IN: "typed",
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
	it("does not ask for a token when the owner saved an OAuth choice", async () => {
		const lines: string[] = [];
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
				ownerChannel: heldChannel(),
				openStore: async () => {
					throw new Error("OAuth credentials are missing");
				},
				startPage: noPage,
			},
		);
		expect(JSON.stringify([lines, outcome])).not.toContain(
			OWNER_CAPTURE_LINE_PREFIX,
		);
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CD_STORE_NEEDS_SIGN_IN" },
		});
	});

	it("completes from outside: the token through HoBo's capture, then the device code into the same run", async () => {
		const provider = vercel();
		const owner = ownerOutside({ approveDevice: provider.approve });
		const channel = heldChannel();
		const store = storeOpener();
		const run = () =>
			prepareVercelConnection(handOffInput(owner.see), {
				env: {},
				locator: LOCATOR,
				ownerChannel: channel,
				openStore: store.open,
				workload: fakeWorkload(),
				fetch: provider.http,
				sleep: async () => undefined,
				startPage: noPage,
			});
		const asked = await run();
		const asks = ownerFacingText(owner.shown, asked);
		expect(
			asks.some((line) =>
				line.startsWith(`${OWNER_CAPTURE_LINE_PREFIX} name=INFISICAL_TOKEN `),
			),
		).toBe(true);
		channel.deposit("INFISICAL_TOKEN", OWNER_TOKEN);
		const outcome = await run();
		if (outcome.kind !== "ready")
			throw new Error(`refused: ${JSON.stringify(outcome)}`);
		expect(store.tokens.at(-1)).toBe(OWNER_TOKEN);
		expect(channel.holds("INFISICAL_TOKEN")).toBe(false);
		expect(
			(await store.port.access("HOBO_CD_VERCEL_INSTALLATION_ID")).status,
		).toBe("ok");
		expect(outcome.credentials?.reveal("VERCEL_TOKEN")).toBe("vercel-token");
		expect(owner.shown.map((line) => line.split(" ")[0])).toContain(
			OWNER_DEVICE_LINE_PREFIX,
		);
		const text = [...asks, ...ownerFacingText(owner.shown, outcome)];
		expectNoLoopback(text);
		expect(text.join("\n")).not.toContain("vercel-token");
		expect(text.join("\n")).not.toContain(OWNER_TOKEN);
		expect(text.join("\n")).not.toMatch(/credential form|egress/u);
	});

	it("refuses with outside paths, never a loopback page, when the owner does nothing", async () => {
		const owner = ownerOutside({ approveDevice: () => undefined });
		const outcome = await prepareVercelConnection(handOffInput(owner.see), {
			env: {},
			locator: LOCATOR,
			ownerChannel: heldChannel(),
			openStore: storeOpener().open,
			fetch: vercel().http,
			sleep: async () => undefined,
			startPage: noPage,
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CD_STORE_NEEDS_SIGN_IN" },
		});
		const text = ownerFacingText(owner.shown, outcome);
		expectNoLoopback(text);
		expect(text.join("\n")).toContain("HoBo MCP App's secret form");
		expect(text.join("\n")).not.toMatch(/credential form|egress/u);
	});
});
