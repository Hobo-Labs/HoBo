import {
	createInfisicalClient,
	InfisicalError,
	type ParsedInfisicalBinding,
} from "@hobo/adapter-infisical";
import {
	type RelaySetupEntry,
	RelaySetupWriteError,
	type RelaySetupWriteRefusal,
	type RelaySetupWriter,
} from "@hobo/ci-gh-actions";
import type { z } from "zod";
import { RELAY_DERIVED_KEYS } from "./relay-derived-keys.js";
import { RELAY_RUNTIME_CONFIG_SETTINGS } from "./relay-runtime-config-schema.js";

const CURATED: readonly RelaySetupEntry[] = [
	{
		name: "HOBO_CI_PUBLIC_URL",
		title: "Relay public origin",
		description:
			"The relay's public HTTPS origin, with no path or trailing slash.",
	},
	{
		name: "HOBO_CI_BOOTSTRAP_ACCOUNT_ID",
		title: "Owner account id",
		description:
			"The owner's relay account id: letters, digits, - and _, at most 80.",
	},
	{
		name: "HOBO_CI_BOOTSTRAP_TOKEN_SHA256",
		title: "Invitation token digest",
		description:
			"Lowercase hex SHA-256 of the owner's invitation token, never the token itself.",
	},
	{
		name: "HOBO_CI_CONTROL_TOKENS_JSON",
		title: "Account API credential bindings",
		description:
			'JSON {"tokens":[{"accountId","tokenSha256","scopes"}]}: token digests, never tokens.',
	},
	{
		name: "HOBO_CI_CONFIG_JSON",
		title: "Relay config document",
		description: "The relay's config document, as hobo ci writes it (JSON).",
	},
	{
		name: "HOBO_CI_GITHUB_APP_ID",
		title: "GitHub App id",
		description: "The numeric App id from the App's settings page.",
	},
	{
		name: "HOBO_CI_GITHUB_APP_CLIENT_ID",
		title: "GitHub App client id",
		description: "The App's client id from its settings page.",
	},
	{
		name: "HOBO_CI_GITHUB_APP_PRIVATE_KEY",
		title: "GitHub App private key (PEM)",
		description:
			"The App's RSA private key, 2048 bits or more. Pasted line breaks may be lost; the relay restores them.",
	},
	{
		name: "HOBO_CI_WEBHOOK_SECRET",
		title: "GitHub App webhook secret",
		description: "The App's webhook secret: 32 bytes or more.",
	},
	{
		name: "HOBO_CI_GITHUB_APP_CLIENT_SECRET",
		title: "GitHub App client secret",
		description: "A client secret generated on the App's settings page.",
	},
];

const DERIVED: ReadonlySet<string> = new Set(RELAY_DERIVED_KEYS);
const CURATED_NAMES: ReadonlySet<string> = new Set(
	CURATED.map((entry) => entry.name),
);
const SETTINGS: ReadonlyMap<string, z.ZodType> = new Map(
	Object.entries(RELAY_RUNTIME_CONFIG_SETTINGS),
);

export const RELAY_SETUP_ENTRIES: readonly RelaySetupEntry[] = Object.freeze([
	...CURATED,
	...[...SETTINGS.keys()]
		.filter((name) => !CURATED_NAMES.has(name) && !DERIVED.has(name))
		.map((name) => ({
			name,
			title: name,
			description: "A value the relay accepts for this entry.",
		})),
]);

const PEM =
	/^-----BEGIN (?<label>[A-Z0-9 ]{1,40})-----\s*(?<body>[A-Za-z0-9+/=\s]+?)\s*-----END \k<label>-----$/u;

export function restorePem(value: string): string {
	const match = PEM.exec(value.replace(/\\n/gu, "\n").trim());
	const label = match?.groups?.label;
	const body = match?.groups?.body;
	if (label === undefined || body === undefined) return value;
	const lines = body.replace(/\s+/gu, "").match(/.{1,64}/gu) ?? [];
	return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export function acceptRelaySetupValue(
	name: string,
	value: string,
): string | undefined {
	const setting = SETTINGS.get(name);
	if (setting === undefined || DERIVED.has(name)) return undefined;
	const candidate =
		name === "HOBO_CI_GITHUB_APP_PRIVATE_KEY"
			? restorePem(value)
			: value.trim();
	return setting.safeParse(candidate).success ? candidate : undefined;
}

const REFUSED_CODES: ReadonlySet<string> = new Set([
	"login-denied",
	"unauthorized",
	"forbidden",
	"approval-required",
]);

export function createInfisicalRelaySetupWriter(
	binding: ParsedInfisicalBinding,
	options: Readonly<{ fetch?: typeof fetch }> = {},
): RelaySetupWriter {
	return async (credential, entries) => {
		const client = createInfisicalClient({
			binding,
			auth: {
				method: "universal-auth",
				clientId: credential.clientId,
				clientSecret: credential.clientSecret,
			},
			retry: { attempts: 1 },
			...(options.fetch === undefined ? undefined : { fetch: options.fetch }),
		});
		try {
			await client.signIn();
			for (const [name, value] of entries) await client.putSecret(name, value);
		} catch (error) {
			const refusal: RelaySetupWriteRefusal =
				error instanceof InfisicalError && REFUSED_CODES.has(error.code)
					? "writer-refused"
					: "store-unavailable";
			throw new RelaySetupWriteError(refusal);
		} finally {
			await client.revoke().catch(() => undefined);
		}
	};
}
