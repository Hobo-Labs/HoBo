import type { SettingsStore } from "@hobo/connect-ui";
import type { TrustedVault } from "@hobo/core";

import {
	type BitwardenSignInKey,
	bitwardenApiKeyPage,
	bitwardenEndpoints,
	newBitwardenDeviceId,
	parseBitwardenApiKey,
	parseBitwardenDeviceId,
	parseBitwardenId,
	parseBitwardenServer,
	provisionBitwardenAccessToken,
} from "./bitwarden-provision.js";
import { parseHttpsOrigin, SettingParseError } from "./parsed-values.js";

export interface BitwardenSignInRefusal {
	readonly code: string;
	readonly message: string;
	readonly remediation: readonly string[];
}

export interface EnsureBitwardenSignInOptions {
	readonly family: "ci" | "cd";
	/** The run's vault: the API key in, the access token out. */
	readonly vault: TrustedVault;
	/** Non-secret settings (BWS_SERVER, BWS_ORGANIZATION_ID, BWS_PROJECT_ID). */
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The committed locator: ids and this run's device id are kept there. */
	readonly locator: SettingsStore;
	readonly fetch: typeof fetch;
	readonly emit: (line: string) => void;
	/** A handed-off run (a remote box): the API key may come through the egress proxy. */
	readonly handOff: boolean;
	/** Whether the run prints progress; the approval line needs it. */
	readonly silent: boolean;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	readonly timeoutMs?: number;
}

/**
 * Give a run whose owner chose Bitwarden an access token when the
 * environment provided none, from the owner's personal API key and one
 * approved login request. The caller calls it only when the store did not
 * open, so a token already in the vault was refused and is replaced. Returns
 * nothing when there is no API key (the caller then names both ways in), or
 * the refusal.
 */
export async function ensureBitwardenSignIn(
	options: EnsureBitwardenSignInOptions,
): Promise<BitwardenSignInRefusal | undefined> {
	const { vault } = options;
	const fam = options.family.toUpperCase();
	const saved = await options.locator.read();
	const setting = (name: string) =>
		options.env[name] || saved[name] || undefined;
	try {
		const region = parseBitwardenServer(setting("BWS_SERVER"));
		const serverUrlText = setting("BITWARDEN_SERVER_URL");
		const serverUrl =
			serverUrlText !== undefined
				? parseHttpsOrigin("BITWARDEN_SERVER_URL", serverUrlText)
				: undefined;
		const endpoints = bitwardenEndpoints(region, serverUrl);
		// The API key the ceremony collected (the setup page, or the
		// environment), else, from a remote box, the one the session's egress
		// proxy injects as HTTP Basic client authentication.
		const clientId = vault.reveal("BW_CLIENTID") ?? setting("BW_CLIENTID");
		const clientSecret = vault.reveal("BW_CLIENTSECRET");
		let apiKey: BitwardenSignInKey;
		if (clientId !== undefined && clientSecret !== undefined)
			apiKey = parseBitwardenApiKey(clientId, clientSecret);
		else if (!options.handOff) return undefined;
		else if (endpoints.selfHosted)
			// A self-hosted server reads the key only from the request body,
			// which the proxy cannot fill.
			return {
				code: `HOBO_${fam}_BITWARDEN_NEEDS_API_KEY`,
				message:
					"Your self-hosted Bitwarden server reads the API key only from the sign-in request itself, so a remote run cannot take it through the session's credential form.",
				remediation: [
					`Run hobo ${options.family} up at your own terminal: the setup page asks for your personal API key (${bitwardenApiKeyPage(endpoints)}).`,
					"Or add BW_CLIENTID and BW_CLIENTSECRET to this environment's secrets; the run moves them into its memory and out of the environment.",
				],
			};
		else apiKey = { kind: "egress-proxy" };
		// Called only when the store did not open: a token in hand was refused
		// (revoked or expired), so the API key replaces it with a new one.
		vault.drop("BWS_ACCESS_TOKEN");
		vault.drop("BITWARDEN_ORG_KEY");
		if (options.silent)
			return {
				code: `HOBO_${fam}_HANDOFF_SILENT`,
				message:
					"Approving the Bitwarden login request needs progress output. Omit --json and -q, then retry.",
				remediation: [`Run hobo ${options.family} up without --json or -q.`],
			};
		const organization = setting("BWS_ORGANIZATION_ID");
		const project = setting("BWS_PROJECT_ID");
		// A stable device id: Bitwarden knows the device after its first
		// sign-in, and the owner is not mailed about a new device every run.
		const deviceText = saved.BITWARDEN_DEVICE_ID;
		const deviceId =
			deviceText !== undefined
				? parseBitwardenDeviceId(deviceText)
				: newBitwardenDeviceId();
		if (deviceText === undefined)
			await options.locator.write({ ...saved, BITWARDEN_DEVICE_ID: deviceId });
		const result = await provisionBitwardenAccessToken({
			family: options.family,
			endpoints,
			apiKey,
			deviceId,
			...(organization !== undefined
				? {
						organizationId: parseBitwardenId(
							"BWS_ORGANIZATION_ID",
							organization,
						),
					}
				: undefined),
			...(project !== undefined
				? { projectId: parseBitwardenId("BWS_PROJECT_ID", project) }
				: undefined),
			fetch: options.fetch,
			emit: options.emit,
			...(options.sleep !== undefined ? { sleep: options.sleep } : undefined),
			...(options.now !== undefined ? { now: options.now } : undefined),
			...(options.timeoutMs !== undefined
				? { timeoutMs: options.timeoutMs }
				: undefined),
		});
		if (result.kind === "refused") return result;
		const latest = await options.locator.read();
		const where = {
			BITWARDEN_DEVICE_ID: deviceId,
			BWS_SERVER: region,
			...(serverUrl !== undefined
				? { BITWARDEN_SERVER_URL: serverUrl }
				: undefined),
			BWS_ORGANIZATION_ID: result.organizationId,
		};
		if (result.kind === "vault") {
			vault.put("BITWARDEN_ORG_KEY", result.organizationKey);
			await options.locator.write({
				...latest,
				...where,
				BITWARDEN_STORAGE: "vault",
				BITWARDEN_COLLECTION_ID: result.collectionId,
			});
			options.emit(
				`The Bitwarden vault is ready: secure notes in the collection "hobo" of organization ${result.organizationId}; this run holds the organization key in memory only.`,
			);
			return undefined;
		}
		vault.put("BWS_ACCESS_TOKEN", result.token);
		await options.locator.write({
			...latest,
			...where,
			BITWARDEN_STORAGE: "secrets-manager",
			BWS_PROJECT_ID: result.projectId,
		});
		options.emit(
			`Bitwarden Secrets Manager is ready: project and machine account "hobo" in organization ${result.organizationId}, with a one-day access token held in this run's vault.`,
		);
		return undefined;
	} catch (error) {
		if (!(error instanceof SettingParseError)) throw error;
		return {
			code: `HOBO_${fam}_SETTING_INVALID`,
			message: error.message,
			remediation: [
				`Fix ${error.setting} in this environment's settings: ${error.rule}.`,
			],
		};
	}
}
