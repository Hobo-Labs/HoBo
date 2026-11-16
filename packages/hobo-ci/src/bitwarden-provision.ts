import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
	accessCode,
	accessTokenMaterial,
	BitwardenCryptoError,
	decryptEncString,
	decryptRsaEncString,
	encryptEncString,
	fingerprintPhrase,
	signInRequestKeyPair,
	stretchMasterKey,
	symmetricKey,
	wipe,
} from "./bitwarden-crypto.js";
import { OWNER_CREDENTIAL_LINE_PREFIX } from "./hand-off-store.js";
import { type HttpsOrigin, SettingParseError } from "./parsed-values.js";

/**
 * Provision Bitwarden Secrets Manager for a run that has no access token.
 *
 * Bitwarden encrypts everything with keys only the owner's devices hold, so
 * no API can mint a Secrets Manager token without the owner. This flow keeps
 * them to as little as Bitwarden allows:
 *
 * 1. The run signs in with the owner's **personal API key**
 *    (`BW_CLIENTID`/`BW_CLIENTSECRET`, the names `bw login --apikey` reads),
 *    adopted into the run's vault. That sign-in alone decrypts nothing, but it
 *    makes this run's device one Bitwarden knows, which a "log in with
 *    device" request requires.
 * 2. It picks the organization (the only one with Secrets Manager, or
 *    `BWS_ORGANIZATION_ID`) before asking the owner anything.
 * 3. It sends a sign-in request and prints one `HOBO_OWNER_BITWARDEN_APPROVE`
 *    line with the fingerprint phrase. The owner approves it in any Bitwarden
 *    app they are signed in to; that app hands over the account key,
 *    encrypted to this run's one-time RSA key.
 * 4. With it, where the organization has Secrets Manager, the run finds or
 *    creates the project `hobo` and the machine
 *    account `hobo`, grants the machine account read and write on the
 *    project, and creates an access token that expires in a day. Names and
 *    keys are encrypted here, exactly as Bitwarden's own clients do it.
 *
 *    Without Secrets Manager (Vaultwarden has none; `BITWARDEN_SERVER_URL`
 *    points the run at it), it finds or creates the collection `hobo` and
 *    hands back the organization key, with which the vault store keeps
 *    secrets as encrypted secure notes there.
 *
 * The token (or organization key) goes to the caller (the run's vault); the account and
 * organization keys are zeroed before this returns. Nothing is written to
 * disk except non-secret ids, which the caller keeps in the locator.
 */

// public-contract: the prefix of the line asking the owner to approve a Bitwarden sign-in request.
export const OWNER_BITWARDEN_APPROVE_LINE_PREFIX =
	"HOBO_OWNER_BITWARDEN_APPROVE";
// public-contract: the environment names of the owner's Bitwarden personal API key, as bw reads them.
export const BITWARDEN_API_KEY_ENV = [
	"BW_CLIENTID",
	"BW_CLIENTSECRET",
] as const;
// public-contract: the name of the project and machine account HoBo provisions in Bitwarden.
export const BITWARDEN_PROVISIONED_NAME = "hobo";

export type BitwardenServer = "us" | "eu";

const SERVERS = {
	us: {
		api: "https://api.bitwarden.com",
		identity: "https://identity.bitwarden.com",
		vault: "https://vault.bitwarden.com",
	},
	eu: {
		api: "https://api.bitwarden.eu",
		identity: "https://identity.bitwarden.eu",
		vault: "https://vault.bitwarden.eu",
	},
} as const satisfies Record<
	BitwardenServer,
	Readonly<Record<"api" | "identity" | "vault", string>>
>;

/**
 * Where a Bitwarden-compatible server answers: Bitwarden's US or EU cloud, or
 * a self-hosted server at one origin (Vaultwarden, or self-hosted Bitwarden),
 * whose API is `<origin>/api` and identity server `<origin>/identity`.
 */
export interface BitwardenEndpoints {
	readonly api: string;
	readonly identity: string;
	readonly vault: string;
	/** Whether this is a self-hosted server (`BITWARDEN_SERVER_URL`). */
	readonly selfHosted: boolean;
}

export function bitwardenEndpoints(
	region: BitwardenServer,
	serverUrl?: HttpsOrigin,
): BitwardenEndpoints {
	if (serverUrl !== undefined)
		return {
			api: `${serverUrl}/api`,
			identity: `${serverUrl}/identity`,
			vault: serverUrl,
			selfHosted: true,
		};
	return { ...SERVERS[region], selfHosted: false };
}

/** Where the owner copies their personal API key. */
export function bitwardenApiKeyPage(endpoints: BitwardenEndpoints): string {
	return `${endpoints.vault}/#/settings/security/security-keys`;
}

declare const apiKeyBrand: unique symbol;
declare const deviceIdBrand: unique symbol;
declare const uuidBrand: unique symbol;

/** A Bitwarden personal API key: `user.<uuid>` and its secret. */
export type BitwardenApiKey = {
	readonly kind: "api-key";
	readonly clientId: string;
	readonly clientSecret: string;
} & { readonly [apiKeyBrand]: true };
/**
 * The API key as the agent session's egress proxy holds it: the owner saved
 * it in the session's credential form as a username (client id) and password
 * (client secret), and the proxy sends it as HTTP Basic client
 * authentication (RFC 6749 §2.3.1) on the way to Bitwarden's identity
 * server. This run never holds it.
 */
export type BitwardenProxySignIn = { readonly kind: "egress-proxy" };
/** How a run signs in to the Bitwarden API. */
export type BitwardenSignInKey = BitwardenApiKey | BitwardenProxySignIn;

/** Sign in with a personal API key (client credentials); this device becomes known. */
export function bitwardenSignIn(
	endpoints: BitwardenEndpoints,
	key: BitwardenSignInKey,
	deviceId: BitwardenDeviceId,
	fetchImpl: typeof fetch,
): Promise<Response> {
	const form = new URLSearchParams({
		grant_type: "client_credentials",
		scope: "api",
		deviceType: "25",
		deviceIdentifier: deviceId,
		deviceName: "HoBo",
	});
	if (key.kind === "api-key") {
		form.set("client_id", key.clientId);
		form.set("client_secret", key.clientSecret);
	}
	return fetchImpl(`${endpoints.identity}/connect/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
			Accept: "application/json",
			"Device-Type": "25",
			"Device-Identifier": deviceId,
			"Bitwarden-Client-Name": "cli",
			"Bitwarden-Client-Version": "2026.1.0",
		},
		body: form,
	});
}
/** This run's Bitwarden device identifier: a UUID kept in the locator. */
export type BitwardenDeviceId = string & { readonly [deviceIdBrand]: true };
/** A Bitwarden object id. */
export type BitwardenId = string & { readonly [uuidBrand]: true };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function parseBitwardenApiKey(
	clientId: string,
	clientSecret: string,
): BitwardenApiKey {
	if (clientId.startsWith("organization."))
		throw new SettingParseError(
			"BW_CLIENTID",
			"your personal API key (user.<id>); an organization API key cannot sign in as you",
		);
	if (!/^user\.[0-9a-f-]{36}$/iu.test(clientId))
		throw new SettingParseError(
			"BW_CLIENTID",
			"a personal API key client id: user. followed by your account id",
		);
	if (!/^[A-Za-z0-9]{20,}$/u.test(clientSecret))
		throw new SettingParseError(
			"BW_CLIENTSECRET",
			"the client secret shown with your personal API key",
		);
	// SAFETY: both halves were just checked against the key's shape.
	return { kind: "api-key", clientId, clientSecret } as BitwardenApiKey;
}

export function parseBitwardenDeviceId(text: string): BitwardenDeviceId {
	if (!UUID.test(text))
		throw new SettingParseError("BITWARDEN_DEVICE_ID", "a UUID");
	// SAFETY: a UUID, as just checked.
	return text.toLowerCase() as BitwardenDeviceId;
}

export function newBitwardenDeviceId(): BitwardenDeviceId {
	return parseBitwardenDeviceId(randomUUID());
}

export function parseBitwardenId(setting: string, text: string): BitwardenId {
	if (!UUID.test(text))
		throw new SettingParseError(setting, "a Bitwarden id (a UUID)");
	// SAFETY: a UUID, as just checked.
	return text.toLowerCase() as BitwardenId;
}

export function parseBitwardenServer(
	text: string | undefined,
): BitwardenServer {
	if (text === undefined || text === "" || text === "us") return "us";
	if (text === "eu") return "eu";
	throw new SettingParseError("BWS_SERVER", "us or eu");
}

export interface BitwardenProvisionOptions {
	readonly family: "ci" | "cd";
	readonly endpoints: BitwardenEndpoints;
	readonly apiKey: BitwardenSignInKey;
	readonly deviceId: BitwardenDeviceId;
	readonly organizationId?: BitwardenId;
	readonly projectId?: BitwardenId;
	readonly fetch: typeof fetch;
	readonly emit: (line: string) => void;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	/** How long the owner has to approve (Bitwarden expires requests at 15 minutes). */
	readonly timeoutMs?: number;
	readonly intervalMs?: number;
	/** How long the new access token lives. */
	readonly tokenLifetimeMs?: number;
}

export type BitwardenProvisionResult =
	| {
			readonly kind: "provisioned";
			/** The new access token: for the run's vault only. */
			readonly token: string;
			readonly organizationId: BitwardenId;
			readonly projectId: BitwardenId;
	  }
	| {
			/**
			 * No Secrets Manager (Vaultwarden, or an organization without it):
			 * secrets are secure notes in the organization's collection `hobo`,
			 * read and written with the organization key the run holds.
			 */
			readonly kind: "vault";
			/** The organization key, base64: for the run's vault only. */
			readonly organizationKey: string;
			readonly organizationId: BitwardenId;
			readonly collectionId: BitwardenId;
	  }
	| {
			readonly kind: "refused";
			readonly code: string;
			readonly message: string;
			readonly remediation: readonly string[];
	  };

const tokenResponse = z.object({ access_token: z.string().min(1) });
const profileResponse = z.object({
	email: z.string().min(3),
	key: z.string().nullish(),
	privateKey: z.string().nullish(),
	accountKeys: z
		.object({
			publicKeyEncryptionKeyPair: z
				.object({ wrappedPrivateKey: z.string().nullish() })
				.nullish(),
		})
		.nullish(),
	organizations: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			key: z.string().nullish(),
			organizationUserId: z.string().nullish(),
			enabled: z.boolean().optional(),
			useSecretsManager: z.boolean().optional(),
			accessSecretsManager: z.boolean().optional(),
		}),
	),
});
const created = z.object({ id: z.string() });
const syncCollections = z.object({
	collections: z.array(
		z.object({
			id: z.string(),
			organizationId: z.string(),
			name: z.string().nullish(),
		}),
	),
});
const authResponse = z.object({
	key: z.string().nullish(),
	masterPasswordHash: z.string().nullish(),
	responseDate: z.string().nullish(),
	requestApproved: z.boolean().nullish(),
});
const named = z.object({
	data: z.array(z.object({ id: z.string(), name: z.string().nullish() })),
});
const tokenCreated = z.object({
	id: z.string(),
	clientSecret: z.string().min(1),
});
const grantedPolicies = z
	.object({
		grantedProjectPolicies: z
			.array(
				z.object({
					accessPolicy: z.object({
						grantedProjectId: z.string(),
						read: z.boolean(),
						write: z.boolean(),
					}),
				}),
			)
			.optional(),
	})
	.passthrough();

class ProvisionRefusal extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly remediation: readonly string[],
	) {
		super(message);
	}
}

/** Create (or reuse) Bitwarden's project and machine account, and mint an access token. */
export async function provisionBitwardenAccessToken(
	options: BitwardenProvisionOptions,
): Promise<BitwardenProvisionResult> {
	const fam = options.family.toUpperCase();
	const server = options.endpoints;
	const deviceHeaders = {
		"Device-Type": "25",
		"Device-Identifier": options.deviceId,
		"Bitwarden-Client-Name": "cli",
		"Bitwarden-Client-Version": "2026.1.0",
	};
	const call = async <T>(
		what: string,
		schema: z.ZodType<T>,
		url: string,
		init: RequestInit,
	): Promise<T> => {
		const headers = new Headers(init.headers);
		headers.set("Accept", "application/json");
		for (const [name, value] of Object.entries(deviceHeaders))
			headers.set(name, value);
		const response = await options.fetch(url, { ...init, headers });
		if (!response.ok)
			throw new ProvisionRefusal(
				`HOBO_${fam}_BITWARDEN_API`,
				`Bitwarden refused ${what} (HTTP ${response.status}).`,
				[
					"Check that your account can manage Secrets Manager in this organization (it needs Secrets Manager access and the right to create projects and machine accounts).",
				],
			);
		const text = await response.text();
		const parsed = schema.safeParse(text === "" ? {} : JSON.parse(text));
		if (!parsed.success)
			throw new ProvisionRefusal(
				`HOBO_${fam}_BITWARDEN_API`,
				`Bitwarden answered ${what} in an unexpected shape.`,
				["Retry; if it persists, Bitwarden's API changed: report it."],
			);
		return parsed.data;
	};

	let userKey: Buffer | undefined;
	let privateKey: Buffer | undefined;
	let organizationKey: Buffer | undefined;
	let requestKey: Buffer | undefined;
	try {
		// 1. Sign in with the personal API key: this device becomes known.
		// Through the egress proxy, the owner may not have saved it yet: say
		// what to give, once, and wait for it in this run.
		const sleep =
			options.sleep ??
			((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
		const now = options.now ?? Date.now;
		const timeoutMs = options.timeoutMs ?? 15 * 60_000;
		const identityHost = new URL(server.identity).host;
		let signIn = await bitwardenSignIn(
			server,
			options.apiKey,
			options.deviceId,
			options.fetch,
		);
		if (!signIn.ok && options.apiKey.kind === "egress-proxy") {
			options.emit(
				`${OWNER_CREDENTIAL_LINE_PREFIX} host=${identityHost} guide=${bitwardenApiKeyPage(server)} — in Bitwarden: Account settings → Security → Keys → View API key. Give it to the agent's session in its credential form for ${identityHost} as a username and password: username = client_id, password = client_secret; never in chat. This run waits ${Math.round(timeoutMs / 60_000)} minutes and continues on its own.`,
			);
			const deadline = now() + timeoutMs;
			while (!signIn.ok && now() < deadline) {
				await sleep(options.intervalMs ?? 10_000);
				signIn = await bitwardenSignIn(
					server,
					options.apiKey,
					options.deviceId,
					options.fetch,
				);
			}
		}
		if (!signIn.ok)
			throw new ProvisionRefusal(
				`HOBO_${fam}_BITWARDEN_API_KEY_REJECTED`,
				options.apiKey.kind === "egress-proxy"
					? "Bitwarden did not accept a personal API key from the session's credential form in time."
					: `Bitwarden refused the personal API key (HTTP ${signIn.status}).`,
				[
					options.apiKey.kind === "egress-proxy"
						? `Save your personal API key from ${bitwardenApiKeyPage(server)} in the agent session's credential form for ${identityHost} (username = client_id, password = client_secret), then run again.`
						: `Enter your personal API key again (${bitwardenApiKeyPage(server)}: Account settings → Security → Keys → View API key) when the run asks for it.`,
				],
			);
		const bearer = tokenResponse.parse(await signIn.json()).access_token;
		const authed = { Authorization: `Bearer ${bearer}` };

		// 2. Choose the organization before asking the owner anything.
		const profile = await call(
			"reading your profile",
			profileResponse,
			`${server.api}/accounts/profile`,
			{ headers: authed },
		);
		// Prefer an organization with Secrets Manager; without one (Vaultwarden
		// has none), any organization holds the secrets as vault items.
		const member = profile.organizations.filter(
			(org) => org.enabled !== false && Boolean(org.key),
		);
		const withSecretsManager = member.filter(
			(org) =>
				org.useSecretsManager === true && org.accessSecretsManager !== false,
		);
		const usable = withSecretsManager.length > 0 ? withSecretsManager : member;
		const organization =
			options.organizationId !== undefined
				? member.find((org) => org.id.toLowerCase() === options.organizationId)
				: usable.length === 1
					? usable[0]
					: undefined;
		if (organization === undefined)
			throw new ProvisionRefusal(
				`HOBO_${fam}_BITWARDEN_ORGANIZATION`,
				member.length === 0
					? "You belong to no confirmed organization: the secrets go into one."
					: options.organizationId !== undefined
						? "BWS_ORGANIZATION_ID is not one of your organizations."
						: "You belong to more than one organization: choose one.",
				member.length === 0
					? [
							`Create an organization (a free one is enough) at ${server.vault}/#/create-organization, or ask an admin to confirm your membership, then retry.`,
						]
					: usable.map(
							(org) =>
								`BWS_ORGANIZATION_ID=${org.id} — ${org.name} (a non-secret setting)`,
						),
			);
		const storage =
			organization.useSecretsManager === true &&
			organization.accessSecretsManager !== false
				? "secrets-manager"
				: "vault";
		const organizationId = parseBitwardenId(
			"BWS_ORGANIZATION_ID",
			organization.id,
		);
		if (!organization.key)
			throw new ProvisionRefusal(
				`HOBO_${fam}_BITWARDEN_ORGANIZATION`,
				"Your membership of that organization has no key yet: an admin must confirm you.",
				["Ask an organization admin to confirm your membership, then retry."],
			);

		// 3. Ask the owner to approve this run's sign-in request.
		const pair = signInRequestKeyPair();
		requestKey = pair.pkcs8;
		const code = accessCode();
		const request = await call(
			"the sign-in request",
			created,
			`${server.api}/auth-requests/`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json; charset=utf-8" },
				body: JSON.stringify({
					email: profile.email,
					publicKey: pair.spki.toString("base64"),
					deviceIdentifier: options.deviceId,
					accessCode: code,
					type: 0,
				}),
			},
		);
		const phrase = fingerprintPhrase(profile.email, pair.spki);
		options.emit(
			`${OWNER_BITWARDEN_APPROVE_LINE_PREFIX} server=${new URL(server.vault).host} phrase=${phrase} — open a Bitwarden app signed in to that server (mobile, desktop, browser extension or web vault), approve the login request from "HoBo" whose fingerprint phrase is ${phrase}. ${storage === "vault" ? `This run then keeps its secrets as secure notes in the collection "${BITWARDEN_PROVISIONED_NAME}" of ${organization.name}` : `This run then creates the Secrets Manager project and machine account "${BITWARDEN_PROVISIONED_NAME}" and a one-day access token itself`}, and waits ${Math.round(timeoutMs / 60_000)} minutes.`,
		);
		const deadline = now() + timeoutMs;
		let approved: z.infer<typeof authResponse> | undefined;
		while (approved === undefined) {
			const answer = await call(
				"the sign-in request's status",
				authResponse,
				`${server.api}/auth-requests/${request.id}/response?code=${encodeURIComponent(code)}`,
				{},
			);
			if (answer.requestApproved === true && answer.key) approved = answer;
			else if (answer.responseDate)
				throw new ProvisionRefusal(
					`HOBO_${fam}_BITWARDEN_DENIED`,
					"The Bitwarden login request was denied.",
					["Run again and approve the request whose phrase matches."],
				);
			else if (now() >= deadline)
				throw new ProvisionRefusal(
					`HOBO_${fam}_BITWARDEN_NOT_APPROVED`,
					"The Bitwarden login request was not approved in time.",
					[
						"Run again and approve the request in a Bitwarden app you are signed in to. If none shows it, turn on Settings → Account security → Approve login requests in the mobile or desktop app.",
					],
				);
			else await sleep(options.intervalMs ?? 5_000);
		}

		// 4. The account key, then the organization key.
		const handed = decryptRsaEncString(approved.key ?? "", requestKey);
		if (handed.length === 64) userKey = handed;
		else {
			// An older approving app hands over the 32-byte master key.
			const stretched = stretchMasterKey(handed);
			try {
				userKey = decryptEncString(profile.key ?? "", stretched);
			} finally {
				wipe(handed, stretched);
			}
		}
		symmetricKey(userKey);
		const wrappedPrivate =
			profile.accountKeys?.publicKeyEncryptionKeyPair?.wrappedPrivateKey ??
			profile.privateKey;
		if (!wrappedPrivate)
			throw new ProvisionRefusal(
				`HOBO_${fam}_BITWARDEN_ACCOUNT`,
				"Your Bitwarden account has no key pair yet.",
				["Sign in to the Bitwarden web vault once, then retry."],
			);
		privateKey = decryptEncString(wrappedPrivate, userKey);
		organizationKey = symmetricKey(
			decryptRsaEncString(organization.key, privateKey),
		);
		const orgKey = organizationKey;
		const json = {
			...authed,
			"Content-Type": "application/json; charset=utf-8",
		};
		const nameOf = (encrypted: string | null | undefined) => {
			if (!encrypted) return undefined;
			try {
				return decryptEncString(encrypted, orgKey).toString("utf8");
			} catch {
				return undefined;
			}
		};

		// 5a. No Secrets Manager: the collection `hobo`, found or created.
		if (storage === "vault") {
			const sync = await call(
				"listing collections",
				syncCollections,
				`${server.api}/sync?excludeDomains=true`,
				{ headers: authed },
			);
			const found = sync.collections.find(
				(collection) =>
					collection.organizationId.toLowerCase() === organizationId &&
					nameOf(collection.name) === BITWARDEN_PROVISIONED_NAME,
			);
			const collection =
				found ??
				(await call(
					"creating the collection",
					created,
					`${server.api}/organizations/${organizationId}/collections`,
					{
						method: "POST",
						headers: json,
						body: JSON.stringify({
							name: encryptEncString(BITWARDEN_PROVISIONED_NAME, orgKey),
							externalId: null,
							groups: [],
							users: organization.organizationUserId
								? [
										{
											id: organization.organizationUserId,
											readOnly: false,
											hidePasswords: false,
											manage: true,
										},
									]
								: [],
						}),
					},
				));
			return {
				kind: "vault",
				organizationKey: orgKey.toString("base64"),
				organizationId,
				collectionId: parseBitwardenId(
					"BITWARDEN_COLLECTION_ID",
					collection.id,
				),
			};
		}

		// 5. The project: the given one, else `hobo`, found or created.
		let projectId = options.projectId;
		if (projectId === undefined) {
			const projects = await call(
				"listing projects",
				named,
				`${server.api}/organizations/${organizationId}/projects`,
				{ headers: authed },
			);
			const found = projects.data.find(
				(project) => nameOf(project.name) === BITWARDEN_PROVISIONED_NAME,
			);
			const project =
				found ??
				(await call(
					"creating the project",
					created,
					`${server.api}/organizations/${organizationId}/projects`,
					{
						method: "POST",
						headers: json,
						body: JSON.stringify({
							name: encryptEncString(BITWARDEN_PROVISIONED_NAME, orgKey),
						}),
					},
				));
			projectId = parseBitwardenId("BWS_PROJECT_ID", project.id);
		}

		// 6. The machine account `hobo`, found or created.
		const accounts = await call(
			"listing machine accounts",
			named,
			`${server.api}/organizations/${organizationId}/service-accounts`,
			{ headers: authed },
		);
		const machine =
			accounts.data.find(
				(account) => nameOf(account.name) === BITWARDEN_PROVISIONED_NAME,
			) ??
			(await call(
				"creating the machine account",
				created,
				`${server.api}/organizations/${organizationId}/service-accounts`,
				{
					method: "POST",
					headers: json,
					body: JSON.stringify({
						name: encryptEncString(BITWARDEN_PROVISIONED_NAME, orgKey),
					}),
				},
			));
		const machineId = parseBitwardenId("machine account", machine.id);

		// 7. Read and write on the project, keeping the account's other grants.
		const current = await call(
			"reading the machine account's access",
			grantedPolicies,
			`${server.api}/service-accounts/${machineId}/granted-policies`,
			{ headers: authed },
		);
		const grants = new Map<string, { read: boolean; write: boolean }>();
		for (const policy of current.grantedProjectPolicies ?? [])
			grants.set(policy.accessPolicy.grantedProjectId.toLowerCase(), {
				read: policy.accessPolicy.read,
				write: policy.accessPolicy.write,
			});
		const existing = grants.get(projectId);
		if (existing?.read !== true || existing.write !== true) {
			grants.set(projectId, { read: true, write: true });
			await call(
				"granting the machine account the project",
				z.unknown(),
				`${server.api}/service-accounts/${machineId}/granted-policies`,
				{
					method: "PUT",
					headers: json,
					body: JSON.stringify({
						projectGrantedPolicyRequests: [...grants].map(
							([grantedId, access]) => ({ grantedId, ...access }),
						),
					}),
				},
			);
		}

		// 8. A short-lived access token, made as Bitwarden's clients make it.
		const material = accessTokenMaterial(orgKey);
		try {
			const lifetime = options.tokenLifetimeMs ?? 24 * 60 * 60_000;
			const token = await call(
				"creating the access token",
				tokenCreated,
				`${server.api}/service-accounts/${machineId}/access-tokens`,
				{
					method: "POST",
					headers: json,
					body: JSON.stringify({
						name: encryptEncString(
							`hobo ${options.family} up ${new Date(now()).toISOString()}`,
							orgKey,
						),
						encryptedPayload: material.encryptedPayload,
						key: material.key,
						expireAt: new Date(now() + lifetime).toISOString(),
					}),
				},
			);
			return {
				kind: "provisioned",
				token: `0.${token.id}.${token.clientSecret}:${material.seed.toString("base64")}`,
				organizationId,
				projectId,
			};
		} finally {
			wipe(material.seed);
		}
	} catch (error) {
		if (error instanceof ProvisionRefusal)
			return {
				kind: "refused",
				code: error.code,
				message: error.message,
				remediation: error.remediation,
			};
		if (error instanceof BitwardenCryptoError)
			return {
				kind: "refused",
				code: `HOBO_${fam}_BITWARDEN_ACCOUNT`,
				message: error.message,
				remediation: [
					"Provide a Secrets Manager access token instead (BWS_ACCESS_TOKEN in this environment's settings).",
				],
			};
		throw error;
	} finally {
		wipe(userKey, privateKey, organizationKey, requestKey);
	}
}
