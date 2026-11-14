import type { CommandResult, PrepareInput, PrepareOutcome } from "@hobo/cli";
import {
	type CeremonySetting,
	type ConnectFlow,
	type ConnectPage,
	type ConnectStep,
	configureThen,
	familySettingsStore,
	resolveSettings,
	type SettingsStore,
	startConnectPage,
} from "@hobo/connect-ui";
import {
	type Env,
	type OpenedSecretStore,
	openInBrowser,
	openSecretStore,
	type SecretStoreDeps,
	type SecretStoreId,
	type SecretStoreOpening,
	storeLabel,
	storeSettings,
} from "@hobo/hobo-ci";

import { resolveVercelJunction } from "./junction.js";
import { parseVercelRedirect } from "./redirect.js";
import {
	createVercelConnectFlow,
	VERCEL_CLIENT_SECRET_KEY,
	vercelConnected,
} from "./vercel.js";

// `hobo cd up`'s prepare step: an interactive ceremony that sets up whatever
// the Vercel connection is missing — HoBo CD's Vercel Integration (slug and
// client id), the secret store and its sign-in, and the Integration's client
// secret, which goes straight into the store — then installs the Integration
// and resolves the Vercel junction's credential for this convergence.
// Answered settings (never secrets) are saved under HOBO_HOME for the next
// run; environment variables of the same names win. Idempotent: a stored
// installation opens nothing. `--what-if` opens nothing. Without a person at
// a browser, it refuses and names each missing setting.

// public-contract: the Redirect URL HoBo CD's Integration registers by default.
export const DEFAULT_VERCEL_REDIRECT_URI =
	"http://127.0.0.1:8792/vercel/callback";
const CD_FOLDER = "/hobo-cd";

/** What `hobo cd up` needs to know before it can connect Vercel. */
export const CD_SETTINGS: readonly CeremonySetting[] = Object.freeze([
	{
		field: {
			name: "HOBO_CD_VERCEL_INTEGRATION",
			label: "Vercel Integration slug",
			description: "HoBo CD's Integration (vercel.com/integrations/<slug>).",
			kind: "text",
			required: true,
		},
		validate: (value) =>
			/^[a-z0-9-]{1,64}$/u.test(value)
				? undefined
				: "Lowercase letters, digits and dashes.",
	},
	{
		field: {
			name: "HOBO_CD_VERCEL_CLIENT_ID",
			label: "Integration client ID",
			kind: "text",
			required: true,
		},
		validate: (value) =>
			/^oac_[A-Za-z0-9]+$/u.test(value)
				? undefined
				: "An Integration client id starts with oac_.",
	},
	{
		field: {
			name: "HOBO_CD_VERCEL_REDIRECT_URI",
			label: "Integration Redirect URL",
			kind: "url",
			required: false,
		},
		fallback: DEFAULT_VERCEL_REDIRECT_URI,
	},
	{
		field: {
			name: "HOBO_CD_SECRET_STORE",
			label: "Secret store",
			kind: "choice",
			required: true,
			value: "infisical",
			options: [
				{
					value: "infisical",
					label: "Infisical Cloud (recommended)",
					description: "Workloads sign in with OIDC: no secret to keep.",
				},
				{
					value: "1password",
					label: "1Password",
					description:
						"Unlocked with your desktop app; workloads use a service account.",
				},
			],
		},
	},
]);

const CLIENT_SECRET_SETTING: CeremonySetting = {
	field: {
		name: "HOBO_CD_VERCEL_CLIENT_SECRET",
		label: "Integration client secret",
		description:
			"Written straight to your secret store, once; HoBo reads it from there for each connection.",
		kind: "secret",
		required: true,
	},
};

export interface PrepareVercelDeps extends SecretStoreDeps {
	readonly env?: Env;
	readonly interactive?: boolean;
	readonly openBrowser?: (url: string) => void;
	readonly startPage?: typeof startConnectPage;
	readonly timeoutMs?: number;
	readonly openStore?: (
		id: SecretStoreId,
		env: Env,
	) => Promise<SecretStoreOpening>;
	readonly settings?: SettingsStore;
}

function refused(
	code: string,
	message: string,
	remediation: readonly string[],
): PrepareOutcome {
	const result: CommandResult = {
		ok: false,
		status: "needs-connection",
		code,
		message,
		remediation,
		data: { command: "cd", connection: "vercel" },
	};
	return { kind: "refused", result };
}

function storeIdOf(value: string | undefined): SecretStoreId {
	return value === "1password" || value === "bitwarden" ? value : "infisical";
}

async function ready(
	store: OpenedSecretStore,
	outcome: "created" | "unchanged",
): Promise<PrepareOutcome> {
	const resolved = await resolveVercelJunction(store);
	if (!resolved.ok)
		return refused("HOBO_CD_VERCEL_JUNCTION_UNRESOLVED", resolved.message, [
			"Run hobo cd up again; if it persists, check access to the secret store.",
		]);
	return {
		kind: "ready",
		steps: [
			{
				id: "vercel",
				outcome,
				detail: `junction ${resolved.junction.name} (${resolved.junction.yards.map((y) => y.name).join(" <-> ")}); credential in ${store.id}`,
			},
		],
		runtimeEnv: resolved.runtimeEnv,
	};
}

/** Connect Vercel for `hobo cd up` (or confirm it), then resolve the junction. */
export async function prepareVercelConnection(
	input: PrepareInput,
	deps: PrepareVercelDeps = {},
): Promise<PrepareOutcome> {
	const env = deps.env ?? process.env;
	const settings = deps.settings ?? familySettingsStore("cd", env);
	const saved = await settings.read();
	const openStore =
		deps.openStore ??
		((id: SecretStoreId, storeEnv: Env) => openSecretStore(id, storeEnv, deps));

	const basics = resolveSettings(CD_SETTINGS, env, saved);
	const configuredStore = basics.values.HOBO_CD_SECRET_STORE;
	if (
		configuredStore &&
		configuredStore !== "infisical" &&
		configuredStore !== "1password" &&
		configuredStore !== "bitwarden"
	)
		return refused(
			"HOBO_CD_SECRET_STORE_INVALID",
			"HOBO_CD_SECRET_STORE must be infisical, 1password, or bitwarden.",
			["Unset it to use Infisical, or choose 1password or bitwarden."],
		);
	const storeId = storeIdOf(basics.values.HOBO_CD_SECRET_STORE);
	const storeSide = resolveSettings(
		storeSettings(storeId, CD_FOLDER),
		env,
		saved,
	);

	if (storeSide.missing.length === 0) {
		const opened = await openStore(storeId, { ...env, ...storeSide.values });
		if (opened.ok) {
			let connected: boolean;
			try {
				connected = await vercelConnected(opened.store);
			} catch {
				return refused(
					"HOBO_CD_SECRET_STORE_UNAVAILABLE",
					"Cannot verify the existing Vercel connection in the secret store.",
					[
						"Check store access and reconcile any partial credentials before retrying.",
					],
				);
			}
			if (connected) {
				if (input.whatIf)
					return {
						kind: "ready",
						steps: [
							{
								id: "vercel",
								outcome: "unchanged",
								detail: `already in ${opened.store.id}`,
							},
						],
					};
				return ready(opened.store, "unchanged");
			}
		}
	}
	const missing = [...basics.missing, ...storeSide.missing];
	if (input.whatIf)
		return {
			kind: "ready",
			steps: [
				{
					id: "vercel",
					outcome: "would-create",
					detail:
						missing.length === 0
							? `would install HoBo CD on Vercel and store its token in ${storeId}`
							: `would ask for ${missing.map((field) => field.label).join(", ")}, then install HoBo CD on Vercel`,
				},
			],
		};
	if (!(deps.interactive ?? Boolean(process.stdout.isTTY)))
		return refused(
			"HOBO_CD_CONNECTION_NEEDS_OWNER",
			"Connecting Vercel needs the owner at a browser once; this run cannot show the setup page.",
			[
				"Run hobo cd up once in a terminal; it asks for what is missing and later runs (and CI) find the connection.",
				...(missing.length > 0
					? [
							`Or set ${missing.map((field) => field.name).join(", ")} in the environment.`,
						]
					: []),
			],
		);

	const redirect = parseVercelRedirect(
		basics.values.HOBO_CD_VERCEL_REDIRECT_URI ?? DEFAULT_VERCEL_REDIRECT_URI,
	);
	if (redirect === undefined)
		return refused(
			"HOBO_CD_REDIRECT_INVALID",
			"The Integration's Redirect URL must be a loopback URL with a port (http://127.0.0.1:<port>/<path>).",
			[
				`Register ${DEFAULT_VERCEL_REDIRECT_URI} as the Integration's Redirect URL, or set HOBO_CD_VERCEL_REDIRECT_URI to the one it has.`,
			],
		);

	let vercel: ReturnType<typeof createVercelConnectFlow> | undefined;
	let connectedStore: OpenedSecretStore | undefined;
	const vercelFlowIn = async (
		store: OpenedSecretStore,
		values: Readonly<Record<string, string>>,
	): Promise<ConnectFlow> => {
		connectedStore = store;
		vercel = createVercelConnectFlow({
			integrationSlug: values.HOBO_CD_VERCEL_INTEGRATION ?? "",
			clientId: values.HOBO_CD_VERCEL_CLIENT_ID ?? "",
			redirectUri: redirect.href,
			openStore: async () => ({ ok: true, store }),
			...(deps.fetch !== undefined ? { fetch: deps.fetch } : undefined),
		});
		const first = await vercel.onAction(
			"connect.chooseStore",
			{ store: store.id },
			vercel.initial,
		);
		return { ...vercel, initial: first.step };
	};

	const flow = await configureThen({
		provider: "vercel",
		title: "Set up HoBo CD on Vercel",
		reason:
			"hobo cd up needs HoBo CD's Vercel Integration and a secret store for the access Vercel grants.",
		settings: CD_SETTINGS,
		missing: basics.missing,
		known: basics.values,
		store: settings,
		async proceed(values) {
			const chosen = storeIdOf(values.HOBO_CD_SECRET_STORE);
			const side = storeSettings(chosen, CD_FOLDER);
			const resolved = resolveSettings(side, env, await settings.read());
			// The client secret is asked for only when the store does not hold it.
			let probe: SecretStoreOpening | undefined;
			if (resolved.missing.length === 0)
				probe = await openStore(chosen, { ...env, ...resolved.values });
			const hasSecret =
				probe?.ok === true &&
				(
					await probe.store.port
						.access(VERCEL_CLIENT_SECRET_KEY)
						.catch(() => undefined)
				)?.status === "ok";
			const stageSettings = hasSecret ? side : [...side, CLIENT_SECRET_SETTING];
			const stageMissing = hasSecret
				? resolved.missing
				: [...resolved.missing, CLIENT_SECRET_SETTING.field];
			const stage = await configureThen({
				provider: "vercel",
				title:
					`Connect ${storeLabel(chosen)}`,
				reason: `HoBo keeps the Integration's client secret and the access Vercel grants in ${storeLabel(chosen)}. Coordinates are saved for next time; secrets go only to the store.`,
				settings: stageSettings,
				missing: stageMissing,
				known: resolved.values,
				store: settings,
				async proceed(storeValues) {
					const opened = await openStore(chosen, { ...env, ...storeValues });
					if (!opened.ok) {
						const first = stageMissing[0]?.name ?? "store";
						return {
							ok: false,
							errors: {
								[first]: `${opened.message} ${opened.remediation.join(" ")}`,
							},
						};
					}
					const secret = storeValues.HOBO_CD_VERCEL_CLIENT_SECRET;
					if (secret !== undefined && secret !== "") {
						try {
							await opened.store.port.put(VERCEL_CLIENT_SECRET_KEY, secret);
						} catch {
							return {
								ok: false,
								errors: {
									HOBO_CD_VERCEL_CLIENT_SECRET: `Could not write it to ${chosen}.`,
								},
							};
						}
					}
					return { ok: true, flow: await vercelFlowIn(opened.store, values) };
				},
			});
			return { ok: true, flow: stage };
		},
	});

	const page: ConnectPage = await (deps.startPage ?? startConnectPage)({
		flow,
		port: Number(redirect.port),
		callbackPath: redirect.pathname,
	});
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<ConnectStep>((resolve) => {
		timer = setTimeout(
			() =>
				resolve({
					kind: "failed",
					provider: "vercel",
					message: "The setup page was not finished in time.",
					remediation: ["Run hobo cd up again; what you answered is saved."],
				}),
			deps.timeoutMs ?? 15 * 60_000,
		);
	});
	let step: ConnectStep;
	let browserLaunched = false;
	try {
		input.run.emitProgress(
			`Set up Vercel for HoBo CD in your browser: ${page.url}`,
		);
		(deps.openBrowser ?? openInBrowser)(page.url);
		browserLaunched = true;
		step = await Promise.race([page.done, timedOut]);
	} finally {
		clearTimeout(timer);
		// Give a launched browser time to show the final step; on startup
		// failure there is no browser to wait for, so close immediately.
		await page.close({ graceMs: browserLaunched ? 10_000 : 0 });
	}
	if (step.kind !== "connected" || connectedStore === undefined)
		return refused(
			"HOBO_CD_VERCEL_NOT_CONNECTED",
			step.kind === "failed" ? step.message : "Vercel was not connected.",
			step.kind === "failed" ? step.remediation : [],
		);
	return ready(connectedStore, vercel?.outcome() ?? "created");
}
