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
import {
	captureAll,
	type OwnerChannel,
	type OwnerSettingsStore,
	ownerCaptureLine,
} from "./owner-channel.js";
import { parseHttpsOrigin, SettingParseError } from "./parsed-values.js";

// public-contract: the capture names of a Bitwarden personal API key handed to a waiting run.
export const BITWARDEN_API_KEY_CAPTURES = [
	"BW_CLIENTID",
	"BW_CLIENTSECRET",
] as const;

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
	readonly locator: OwnerSettingsStore;
	readonly fetch: typeof fetch;
	readonly emit: (line: string) => void;
	/** A handed-off run (a remote box): the API key may come through the egress proxy. */
	readonly handOff: boolean;
	/** Whether the run prints progress; the approval line needs it. */
	readonly silent: boolean;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	readonly timeoutMs?: number;
	/** How to reach an owner who is not at this machine (a remote dev box). */
	readonly owner?: OwnerChannel;
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
	let uncertain = false;
	const markUncertain = () => {
		uncertain = true;
		options.locator.markUncertainWrite?.();
	};
	const uncertainRefusal = () => ({
		code: `HOBO_${fam}_STORE_OPERATION_UNCERTAIN`,
		message:
			"A store operation may have completed and needs reconciliation before retrying.",
		remediation: ["Reconcile the store operation before trying setup again."],
	});
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
		const page = bitwardenApiKeyPage(endpoints);
		const captureApiKey = async () => {
			const given =
				options.owner === undefined
					? undefined
					: await captureAll(options.owner, [
							{
								name: "BW_CLIENTID",
								title: "Bitwarden API key: client_id",
								instructions: `In your Bitwarden vault (${page}): Account settings → Security → Keys → View API key. Paste client_id.`,
							},
							{
								name: "BW_CLIENTSECRET",
								title: "Bitwarden API key: client_secret",
								instructions: `In your Bitwarden vault (${page}): Account settings → Security → Keys → View API key. Paste client_secret.`,
							},
						]);
			if (given === undefined) return undefined;
			const parsed = parseBitwardenApiKey(given[0] ?? "", given[1] ?? "");
			vault.put("BW_CLIENTID", parsed.clientId);
			vault.put("BW_CLIENTSECRET", parsed.clientSecret);
			return parsed;
		};
		let apiKey: BitwardenSignInKey;
		if (clientId !== undefined && clientSecret !== undefined)
			apiKey = parseBitwardenApiKey(clientId, clientSecret);
		else if (!options.handOff) return undefined;
		else if (endpoints.selfHosted) {
			const supplied = await captureApiKey();
			if (supplied === undefined)
				return {
					code: `HOBO_${fam}_BITWARDEN_NEEDS_API_KEY`,
					message:
						"Bitwarden needs your personal API key through the secure owner form.",
					remediation:
						options.owner === undefined
							? [
									`Run hobo ${options.family} up through the HoBo MCP server (its ci and cd tools): its secret form takes your personal API key (${page}) straight to the run.`,
								]
							: [
									...BITWARDEN_API_KEY_CAPTURES.map((name) =>
										ownerCaptureLine(name, page),
									),
									"In your Bitwarden vault: Account settings → Security → Keys → View API key. Hand over client_id and client_secret in the HoBo MCP App's secret form; they go only to this run.",
									"Then run again: HoBo creates its own access token after the one login request you approve.",
								],
				};
			apiKey = supplied;
		} else apiKey = { kind: "egress-proxy" };
		// Called only when the store did not open: a token in hand was refused
		// (revoked or expired), so the API key replaces it with a new one.
		vault.drop("BWS_ACCESS_TOKEN");
		vault.drop("BITWARDEN_ORG_KEY");
		const confirm = options.owner?.confirm;
		const privateApproval =
			options.silent &&
			confirm !== undefined &&
			options.owner?.canConfirm?.() === true;
		if (options.silent && !privateApproval)
			return {
				code: `HOBO_${fam}_HANDOFF_SILENT`,
				message:
					"Approving the Bitwarden login request needs progress output. Omit --json and -q, then retry.",
				remediation: [`Run hobo ${options.family} up without --json or -q.`],
			};
		const fetchCurrent: typeof fetch = async (input, init) => {
			options.locator.assertCurrent?.();
			const selection = options.locator.selectionSignal;
			const signal =
				selection === undefined
					? init?.signal
					: init?.signal
						? AbortSignal.any([selection, init.signal])
						: selection;
			const method = (init?.method ?? "GET").toUpperCase();
			const mutation = method !== "GET" && method !== "HEAD";
			const perform = async () => {
				options.locator.assertCurrent?.();
				try {
					const response = await options.fetch(
						input,
						signal === undefined ? init : { ...init, signal },
					);
					options.locator.assertCurrent?.();
					return response;
				} catch (error) {
					if (mutation) markUncertain();
					throw error;
				}
			};
			return mutation && options.locator.runStoreWrite
				? options.locator.runStoreWrite(perform)
				: perform();
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
			fetch: fetchCurrent,
			emit: options.emit,
			...(options.locator.runStoreWrite !== undefined
				? { runMutation: options.locator.runStoreWrite }
				: undefined),
			markUncertainMutation: markUncertain,
			...(privateApproval && apiKey.kind === "egress-proxy"
				? { requestApiKey: captureApiKey }
				: undefined),
			...(privateApproval && confirm !== undefined
				? {
						approve: async (request) => {
							options.locator.assertCurrent?.();
							const accepted = await confirm(request);
							options.locator.assertCurrent?.();
							return accepted;
						},
					}
				: undefined),
			...(privateApproval && options.owner?.choose !== undefined
				? {
						chooseOrganization: async (choices) => {
							options.locator.assertCurrent?.();
							const chosen = await options.owner?.choose?.({
								message: "Choose the Bitwarden organization HoBo should use.",
								choices,
							});
							options.locator.assertCurrent?.();
							return chosen;
						},
					}
				: undefined),
			...(options.sleep !== undefined ? { sleep: options.sleep } : undefined),
			...(options.now !== undefined ? { now: options.now } : undefined),
			...(options.timeoutMs !== undefined
				? { timeoutMs: options.timeoutMs }
				: undefined),
		});
		if (uncertain) return uncertainRefusal();
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
		if (uncertain) return uncertainRefusal();
		if (!(error instanceof SettingParseError)) throw error;
		return {
			code: `HOBO_${fam}_SETTING_INVALID`,
			message: error.message,
			remediation:
				options.owner !== undefined &&
				BITWARDEN_API_KEY_CAPTURES.some((name) => name === error.setting)
					? [
							...BITWARDEN_API_KEY_CAPTURES.map((name) =>
								ownerCaptureLine(
									name,
									bitwardenApiKeyPage(bitwardenEndpoints("us")),
								),
							),
							`Hand over ${error.setting} again in the HoBo MCP App's secret form: ${error.rule}. Then run again.`,
						]
					: [`Enter ${error.setting} again when the run asks: ${error.rule}.`],
		};
	}
}
