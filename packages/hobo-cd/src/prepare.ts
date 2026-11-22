import type { CommandResult, PrepareInput, PrepareOutcome } from "@hobo/cli";
import {
	type CeremonySetting,
	type ConnectFlow,
	type ConnectPage,
	configureThen,
	resolveSettings,
	startConnectPage,
} from "@hobo/connect-ui";
import { createTrustedVault, type TrustedVault } from "@hobo/core";
import {
	adoptStoreSignIn,
	awaitHandOffStore,
	canReachOwner,
	ensureBitwardenSignIn,
	familySettings,
	hoboToolsDir,
	InvalidSecretStoreError,
	ignoredSecretEnvNotice,
	KEPT_STORE_SIGN_INS,
	lazyEgressFetch,
	ONE_PASSWORD_SERVICE_ACCOUNT_EXPIRES_AT,
	type OpenedSecretStore,
	type OwnerStoreDeps,
	openInBrowser,
	ownerLocator,
	ownerStore,
	ownerStoreSessionEnvironment,
	provisionInfisicalAccess,
	provisionOnePasswordAccess,
	runPage,
	scopeRunVault,
	showOwnerPage,
	storeAnswers,
	storeChoiceGuidance,
	storeFailureReason,
	storeIdOf,
	storeSignInGuidance,
	validateOnePasswordServiceAccount,
	withoutSecretEnv,
	withoutStoreSignIn,
	withStoreWriteLock,
	workloadOidcOf,
} from "@hobo/hobo-ci";

import {
	type JournalMemberProvisioner,
	prepareJournalFleet,
} from "./journal-fleet.js";
import { resolveVercelJunction } from "./junction.js";
import { parseVercelRedirect } from "./redirect.js";
import {
	createVercelConnectFlow,
	readVercelConnection,
	type StoredVercelConnection,
	sameVercelConnection,
	VERCEL_CLIENT_SECRET_KEY,
	VERCEL_CONNECTION_KEYS,
} from "./vercel.js";
import {
	awaitVercelDeviceToken,
	OWNER_DEVICE_LINE_PREFIX,
	SYSTEM_CLOCK,
	startVercelDeviceGrant,
	VERCEL_DEVICE_INSTALLATION,
	VercelDeviceError,
	type VercelDeviceGrant,
	vercelDeviceTeam,
	vercelDeviceToken,
} from "./vercel-device.js";

// `hobo cd up`'s prepare step: an interactive ceremony that sets up whatever
// the Vercel connection is missing — HoBo CD's Vercel Integration (slug and
// client id), the secret store and its sign-in, and the Integration's client
// secret, which goes straight into the store — then installs the Integration
// and resolves the Vercel junction's credential for this convergence.
// The store is found through the committed locator and signed in to on the
// page (`ownerStore`, `@hobo/hobo-ci`); the Integration's ids are kept in the
// store as `HOBO_CD_SETTINGS`, so a destroyed devbox is set up again by
// signing in. No secret is read from the environment or written to a disk.
// Idempotent: a stored installation opens nothing. `--what-if` opens
// nothing. Without a person at a browser, it refuses and says why.

// public-contract: the Redirect URL HoBo CD's Integration registers by default.
export const DEFAULT_VERCEL_REDIRECT_URI =
	"http://127.0.0.1:8792/vercel/callback";

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

export interface PrepareVercelDeps extends OwnerStoreDeps {
	readonly interactive?: boolean;
	readonly openBrowser?: (url: string) => void;
	readonly startPage?: typeof startConnectPage;
	readonly timeoutMs?: number;
	/** How the device grant and store probes wait (tests make it instant). */
	readonly sleep?: (ms: number) => Promise<void>;
	/** The device grant's clock (tests drive it virtually). */
	readonly now?: () => number;
	/** How long a handed-off run waits for the owner's sign-in. */
	readonly handOffTimeoutMs?: number;
	/** The run's trusted vault; a fresh one by default. */
	readonly vault?: TrustedVault;
	/**
	 * public-contract: what creates the CD journal's fleet members
	 * (`journal-fleet.ts`). With none, `hobo cd up` provisions no journal and
	 * the CD runtime keeps its single-process SQLite journal.
	 */
	readonly journalProvisioners?: readonly JournalMemberProvisioner[];
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

async function journalStep(
	store: OpenedSecretStore,
	provisioners: readonly JournalMemberProvisioner[] | undefined,
	whatIf: boolean,
) {
	if (provisioners === undefined || provisioners.length === 0) return [];
	try {
		return [await prepareJournalFleet({ store, provisioners, whatIf })];
	} catch (error) {
		if (error instanceof Error && error.name === "ClaimStoreUnavailableError")
			return refused(
				"HOBO_CD_JOURNAL_CLAIM_UNAVAILABLE",
				"The selected store cannot safely guard new CD journal members.",
				[
					"An existing complete journal fleet or a durable, owner-scoped atomic claim store is required.",
				],
			);
		return refused(
			"HOBO_CD_JOURNAL_NOT_PROVISIONED",
			`The CD journal's fleet could not be provisioned: ${error instanceof Error ? error.message : String(error)}`,
			[
				"Run hobo cd up again: members already in your secret store are kept, and only the missing ones are created.",
			],
		);
	}
}

async function ready(
	store: OpenedSecretStore,
	outcome: "created" | "unchanged",
	vault: TrustedVault,
	provisioners: readonly JournalMemberProvisioner[] | undefined,
	matches: (connection: StoredVercelConnection) => boolean,
): Promise<PrepareOutcome> {
	const resolved = await resolveVercelJunction(store, vault, matches);
	if (!resolved.ok)
		return refused("HOBO_CD_VERCEL_JUNCTION_UNRESOLVED", resolved.message, [
			"Run hobo cd up again; if it persists, check access to the secret store.",
		]);
	const journal = await journalStep(store, provisioners, false);
	if (!Array.isArray(journal)) return journal;
	if (provisioners !== undefined && provisioners.length > 0) {
		const current = await resolveVercelJunction(store, vault, matches);
		if (!current.ok)
			return refused("HOBO_CD_VERCEL_JUNCTION_UNRESOLVED", current.message, [
				"Run hobo cd up again; if it persists, check access to the secret store.",
			]);
	}
	return {
		kind: "ready",
		steps: [
			{
				id: "vercel",
				outcome,
				detail: `junction ${resolved.junction.name} (${resolved.junction.yards.map((y) => y.name).join(" <-> ")}); credential in ${store.id}`,
			},
			...journal,
		],
		credentials: vault,
	};
}

/** Connect Vercel for `hobo cd up` (or confirm it), then resolve the junction. */
export async function prepareVercelConnection(
	input: PrepareInput,
	deps: PrepareVercelDeps = {},
): Promise<PrepareOutcome> {
	const vault = scopeRunVault(deps.vault ?? createTrustedVault());
	let handedOff = false;
	try {
		const outcome = await prepareVercelWithVault(input, {
			...deps,
			fetch: deps.fetch ?? lazyEgressFetch(deps.env ?? process.env),
			vault,
		});
		try {
			ownerLocator(deps).assertCurrent?.();
		} catch {
			return refused(
				"HOBO_CD_OWNER_CHOICE_CHANGED",
				"The owner changed the selected store while this operation was running.",
				["Run hobo cd up again for the selected store."],
			);
		}
		handedOff = outcome.kind === "ready" && outcome.credentials === vault;
		return outcome;
	} finally {
		// What signs this run in to the store stays for the next run, in the
		// owner channel's memory only.
		let current = true;
		try {
			ownerLocator(deps).assertCurrent?.();
		} catch {
			current = false;
		}
		for (const name of current ? KEPT_STORE_SIGN_INS : []) {
			const value = vault.reveal(name);
			if (value !== undefined) deps.ownerChannel?.vault?.put(name, value);
		}
		// The lifecycle owns the vault only after a successful handoff.
		if (!handedOff) vault.clear();
	}
}

async function prepareVercelWithVault(
	input: PrepareInput,
	deps: PrepareVercelDeps & { readonly vault: TrustedVault },
): Promise<PrepareOutcome> {
	const env = deps.env ?? process.env;
	// The environment's own store sign-in (a Bitwarden Secrets Manager access
	// token) moves into this run's vault and leaves the environment. It says
	// Bitwarden is configured here; it is used only if the owner chose it.
	const storeEnv = await ownerStoreSessionEnvironment(deps, env);
	const storeSignIn =
		storeEnv === env &&
		adoptStoreSignIn(
			deps.env === undefined ? process.env : { ...deps.env },
			deps.vault,
		);
	const notice = ignoredSecretEnvNotice(
		storeSignIn ? withoutStoreSignIn(env) : env,
	);
	if (notice !== undefined) input.run.emitProgress(notice);
	const plainEnv = withoutSecretEnv(storeEnv);
	if (storeEnv.HOBO_SECRET_STORE) {
		try {
			storeIdOf(storeEnv.HOBO_SECRET_STORE);
		} catch (error) {
			if (!(error instanceof InvalidSecretStoreError)) throw error;
			return refused("HOBO_CD_SECRET_STORE_INVALID", error.message, [
				"Choose infisical, 1password, or bitwarden in the store locator.",
			]);
		}
		// The validated choice is a non-secret setting despite its name.
		plainEnv.HOBO_SECRET_STORE = storeEnv.HOBO_SECRET_STORE;
	}
	const vault = deps.vault;
	const workloadOidc = deps.workloadOidc ?? workloadOidcOf(env);
	const openOwner = () =>
		ownerStore("cd", vault, {
			...deps,
			env: plainEnv,
			// The setup page collected Bitwarden's API key: provision from it
			// (one approved login request) before the store opens.
			beforeOpen: async (id, values) => {
				if (id !== "bitwarden") return { ok: true };
				if (values.BW_CLIENTID) vault.put("BW_CLIENTID", values.BW_CLIENTID);
				const refusal = await ensureBitwardenSignIn({
					family: "cd",
					vault,
					env: { ...plainEnv, ...values },
					locator: ownerLocator(deps),
					fetch: deps.fetch ?? fetch,
					emit: (line) => input.run.emitProgress(line),
					silent: false,
					handOff: false,
					...(deps.sleep !== undefined ? { sleep: deps.sleep } : undefined),
				});
				return refusal === undefined ? { ok: true } : { ok: false, ...refusal };
			},
			...(workloadOidc !== undefined ? { workloadOidc } : undefined),
			// An OAuth sign-in approves in this machine's browser: a terminal
			// run only, never a handed-off one.
			noBrowser: input.handOff === true || input.whatIf,
			oauthBrowser: {
				open: deps.openBrowser ?? openInBrowser,
				emit: (line) => input.run.emitProgress(line),
			},
		});
	let owner: Awaited<ReturnType<typeof ownerStore>>;
	try {
		// A store sign-in an earlier run kept (the owner signed in once).
		const kept = deps.ownerChannel?.vault;
		const restored = KEPT_STORE_SIGN_INS.filter((name) => {
			const value = kept?.reveal(name);
			if (value === undefined || vault.has(name)) return false;
			vault.put(name, value);
			return true;
		});
		owner = await openOwner();
		// The store refused it (expired, revoked): forget it and go on as if
		// it never was, so a stale token cannot wedge later runs.
		if (owner.opened === undefined && restored.length > 0) {
			for (const name of restored) {
				vault.drop(name);
				kept?.drop(name);
			}
			owner = await openOwner();
		}
		// The owner chooses their store; a handed-off run never assumes one.
		if (input.handOff === true && !input.whatIf && !owner.chosen)
			return refused(
				"HOBO_CD_STORE_CHOICE",
				"Choose your secret store first: Infisical, 1Password or Bitwarden.",
				storeChoiceGuidance(
					storeSignIn ? new Set(["bitwarden"] as const) : undefined,
				),
			);
		// The owner chose Infisical: HoBo installs its CLI, uses the owner's
		// session (or one browser sign-in) and creates its own identity and
		// access through Infisical's API. Nothing is provisioned by hand.
		if (
			owner.id === "infisical" &&
			// Only with the machine its caller hands it (the composed CLI).
			deps.runCommand !== undefined &&
			owner.chosen &&
			!input.whatIf &&
			owner.opened === undefined &&
			!vault.has("INFISICAL_TOKEN") &&
			workloadOidc === undefined &&
			// A sign-in the owner chose explicitly (OAuth, the egress proxy) stands.
			!plainEnv.INFISICAL_SIGN_IN &&
			!(await ownerLocator(deps).read()).INFISICAL_SIGN_IN
		) {
			const locator = ownerLocator(deps);
			const projectId =
				plainEnv.INFISICAL_PROJECT_ID ??
				(await locator.read()).INFISICAL_PROJECT_ID;
			if (projectId !== undefined && projectId !== "") {
				const access = await (deps.infisicalAccess ?? provisionInfisicalAccess)(
					{
						family: "cd",
						projectId,
						run: deps.runCommand,
						which: deps.which ?? (async () => undefined),
						toolsDir: hoboToolsDir(),
						fetch: deps.fetch ?? fetch,
						emit: (line) => input.run.emitProgress(line),
						interactive: input.handOff !== true,
						apiOrigin:
							plainEnv.INFISICAL_SITE_URL ??
							(await locator.read()).INFISICAL_SITE_URL ??
							"https://app.infisical.com",
						...(deps.ownerChannel !== undefined
							? { owner: deps.ownerChannel }
							: undefined),
						...(owner.infisicalFolder !== undefined
							? { folder: owner.infisicalFolder }
							: undefined),
					},
				);
				if (access.kind === "refused")
					return refused(access.code, access.message, access.remediation);
				if (access.token !== undefined)
					vault.put("INFISICAL_TOKEN", access.token);
				await locator.write({
					...(await locator.read()),
					INFISICAL_IDENTITY_ID: access.identityId,
				});
				owner = await openOwner();
			}
		}
		if (
			owner.id === "1password" &&
			(deps.runCommand !== undefined ||
				(input.handOff === true && deps.ownerChannel !== undefined)) &&
			owner.chosen &&
			!input.whatIf &&
			owner.opened === undefined &&
			!vault.has("OP_SERVICE_ACCOUNT_TOKEN") &&
			// A sign-in the owner chose explicitly (desktop app, Connect) stands.
			!plainEnv.OP_ACCOUNT &&
			!plainEnv.OP_CONNECT_HOST
		) {
			const locator = ownerLocator(deps);
			const saved = await locator.read();
			const vaultId = plainEnv.OP_VAULT_ID ?? saved.OP_VAULT_ID;
			if (
				vaultId !== undefined &&
				vaultId !== "" &&
				!saved.OP_ACCOUNT &&
				!saved.OP_CONNECT_HOST
			) {
				const access = await (
					deps.onePasswordAccess ?? provisionOnePasswordAccess
				)({
					family: "cd",
					vaultId,
					...(deps.runCommand !== undefined
						? { run: deps.runCommand }
						: undefined),
					which: deps.which ?? (async () => undefined),
					toolsDir: hoboToolsDir(),
					emit: (line) => input.run.emitProgress(line),
					interactive: input.handOff !== true,
					validateServiceAccount:
						deps.validateOnePasswordServiceAccount ??
						validateOnePasswordServiceAccount,
					...(deps.now !== undefined ? { now: deps.now } : undefined),
					...(deps.ownerChannel !== undefined
						? { owner: deps.ownerChannel }
						: undefined),
				});
				if (access.kind === "refused")
					return refused(access.code, access.message, access.remediation);
				vault.put("OP_SERVICE_ACCOUNT_TOKEN", access.token);
				await locator.write({
					...(await locator.read()),
					[ONE_PASSWORD_SERVICE_ACCOUNT_EXPIRES_AT]: access.expiresAt,
				});
				owner = await openOwner();
			}
		}
		// The owner chose Bitwarden and gave no access token: with their
		// personal API key the run creates its own, after one approval.
		if (
			owner.id === "bitwarden" &&
			owner.chosen &&
			!input.whatIf &&
			owner.opened === undefined
		) {
			const refusal = await ensureBitwardenSignIn({
				family: "cd",
				vault,
				env: plainEnv,
				locator: ownerLocator(deps),
				fetch: deps.fetch ?? fetch,
				emit: (line) => input.run.emitProgress(line),
				silent: input.run.flags.json || input.run.flags.quiet,
				handOff: input.handOff === true,
				...(deps.ownerChannel !== undefined
					? { owner: deps.ownerChannel }
					: undefined),
				...(deps.sleep !== undefined ? { sleep: deps.sleep } : undefined),
				...(deps.handOffTimeoutMs !== undefined
					? { timeoutMs: deps.handOffTimeoutMs }
					: undefined),
			});
			if (refusal !== undefined)
				return refused(refusal.code, refusal.message, refusal.remediation);
			owner = await openOwner();
		}
		// The owner is needed only if the store does not answer yet: a silent
		// run cannot ask, so it refuses before waiting.
		const needsOwner =
			input.handOff === true &&
			!input.whatIf &&
			!(await storeAnswers(owner, "cd"));
		// Through the HoBo MCP server (--json, an owner channel) no progress
		// line reaches anyone: say why the store did not open, never wait.
		if (
			needsOwner &&
			deps.ownerChannel !== undefined &&
			(input.run.flags.json || input.run.flags.quiet)
		)
			return refused(
				"HOBO_CD_STORE_UNAVAILABLE",
				owner.unopened?.message ?? `${owner.id} did not answer this run.`,
				owner.unopened?.remediation ?? [
					"Run again: HoBo signs in to the store afresh.",
				],
			);
		if (
			needsOwner &&
			owner.canAwaitEgressCredential &&
			(input.run.flags.json || input.run.flags.quiet)
		)
			return refused(
				"HOBO_CD_HANDOFF_SILENT",
				"The owner hand-off needs progress output. Omit --json and -q, then retry.",
				["Run hobo cd up --hand-off without --json or -q."],
			);
		if (needsOwner && owner.canAwaitEgressCredential)
			owner = await awaitHandOffStore({
				family: "cd",
				open: openOwner,
				emit: (line) => input.run.emitProgress(line),
				...(deps.sleep !== undefined ? { sleep: deps.sleep } : undefined),
				...(deps.handOffTimeoutMs !== undefined
					? { timeoutMs: deps.handOffTimeoutMs }
					: undefined),
			});
		else if (needsOwner) owner = { ...owner, opened: undefined };
	} catch (error) {
		if (!(error instanceof InvalidSecretStoreError)) throw error;
		return refused("HOBO_CD_SECRET_STORE_INVALID", error.message, [
			"Choose infisical, 1password, or bitwarden in the store locator.",
		]);
	}

	let connection: StoredVercelConnection | undefined;
	try {
		connection =
			owner.opened !== undefined
				? await readVercelConnection(owner.opened)
				: undefined;
	} catch {
		return refused(
			"HOBO_CD_SECRET_STORE_UNAVAILABLE",
			"Cannot verify the existing Vercel connection in the secret store.",
			[
				"Check store access and reconcile any partial credentials before retrying.",
			],
		);
	}
	if (owner.opened !== undefined && connection !== undefined) {
		if (input.whatIf) {
			const journal = await journalStep(
				owner.opened,
				deps.journalProvisioners,
				true,
			);
			if (!Array.isArray(journal)) return journal;
			return {
				kind: "ready",
				steps: [
					{
						id: "vercel",
						outcome: "unchanged",
						detail: `already in ${owner.opened.id}`,
					},
					...journal,
				],
			};
		}
		const expected = connection;
		return ready(
			owner.opened,
			"unchanged",
			vault,
			deps.journalProvisioners,
			(current) => sameVercelConnection(expected, current),
		);
	}
	if (input.whatIf)
		return {
			kind: "ready",
			steps: [
				{
					id: "vercel",
					outcome: "would-create",
					detail:
						owner.opened === undefined
							? `would sign in to ${owner.id}${owner.missing.length > 0 ? ` (asking for ${owner.missing.map((f) => f.label).join(", ")})` : ""}, then install HoBo CD on Vercel unless the store holds it`
							: `would install HoBo CD on Vercel and store its token in ${owner.id}`,
				},
			],
		};
	// Through the HoBo MCP server the owner channel carries every owner step;
	// only a plain --json run cannot reach the owner.
	if (
		input.handOff === true &&
		deps.ownerChannel === undefined &&
		(input.run.flags.json || input.run.flags.quiet)
	)
		return refused(
			"HOBO_CD_HANDOFF_SILENT",
			"The owner hand-off needs progress output. Omit --json and -q, then retry.",
			["Run hobo cd up --hand-off without --json or -q."],
		);
	// Handed off, the owner may be anywhere: nothing is served here and
	// nothing redirects back to this machine. Vercel is connected with the
	// device grant (the owner approves on vercel.com); the store must already
	// open without a page (a workload's OIDC, or a sign-in the agent's egress
	// proxy injects: INFISICAL_SIGN_IN "egress-proxy" in the locator).
	if (input.handOff === true) {
		if (owner.opened === undefined)
			return refused(
				"HOBO_CD_STORE_NEEDS_SIGN_IN",
				`A handed-off run shows no sign-in page: ${owner.id} must open without one.`,
				[
					"Choose the store and give its non-secret ids when the run asks; they are kept in your own HoBo settings.",
					...storeSignInGuidance(owner.id, "cd"),
				],
			);
		const store = owner.opened;
		const http = deps.fetch ?? fetch;
		// Through the HoBo MCP server no call may block on a person: the grant
		// runs off the request path and writes the connection to the store;
		// the next call finds it there (the "unchanged" path above).
		const jobs = deps.ownerChannel?.jobs;
		if (jobs !== undefined) {
			const key = `vercel-device:${store.reference("HOBO_CD_VERCEL_TOKEN")}`;
			const awaiting = (link: string, code: string) =>
				refused(
					"HOBO_CD_VERCEL_AWAITING_APPROVAL",
					"Waiting for you to approve HoBo CD on Vercel.",
					[
						`${OWNER_DEVICE_LINE_PREFIX} ${link} code=${code}`,
						`Approve HoBo CD on Vercel at that link (the code is ${code}), then run hobo cd up --hand-off again.`,
					],
				);
			// A host that shows forms: the link in one, which the owner submits
			// once they approved; the grant's own outcome then ends the step in
			// this same call. Nothing is relayed through the agent. `undefined`
			// when this host shows no form.
			const viaForm = async (
				link: string,
				code: string,
			): Promise<PrepareOutcome | undefined> => {
				const approved = await deps.ownerChannel
					?.confirm?.({
						url: link,
						message: `Approve HoBo CD on Vercel (code ${code}), then submit.`,
					})
					.catch(() => false);
				if (approved === undefined) return undefined;
				if (!approved) return awaiting(link, code);
				const outcome = await jobs.outcome(key);
				if (outcome?.state === "failed") {
					jobs.forget(key);
					return refused(outcome.code, outcome.message, [
						"Run hobo cd up --hand-off again for a new code.",
					]);
				}
				// Done (or its record already gone, taken by another call): what
				// the store holds decides, pinned so a connection replaced
				// meanwhile is caught, never assumed.
				if (outcome?.state !== "pending") {
					jobs.forget(key);
					let current: StoredVercelConnection | undefined;
					try {
						current = await readVercelConnection(store);
					} catch {
						current = undefined;
					}
					if (current !== undefined) {
						const expected = current;
						return ready(
							store,
							"created",
							vault,
							deps.journalProvisioners,
							(next) => sameVercelConnection(expected, next),
						);
					}
				}
				return awaiting(link, code);
			};
			const job = jobs.status(key);
			// Still waiting on the owner (a form they closed, say): the same
			// link and code again, in the form.
			if (job?.state === "pending")
				return (
					(await viaForm(job.link, job.code)) ?? awaiting(job.link, job.code)
				);
			jobs.forget(key);
			if (job?.state === "failed")
				return refused(job.code, job.message, [
					"Run hobo cd up --hand-off again for a new code.",
				]);
			let grant: VercelDeviceGrant;
			try {
				grant = await startVercelDeviceGrant({
					fetch: http,
					...(plainEnv.HOBO_CD_VERCEL_DEVICE_CLIENT_ID
						? { clientId: plainEnv.HOBO_CD_VERCEL_DEVICE_CLIENT_ID }
						: undefined),
				});
			} catch (error) {
				if (!(error instanceof VercelDeviceError)) throw error;
				return refused(error.code, error.message, [
					"Run hobo cd up --hand-off again for a new code.",
				]);
			}
			const started = jobs.start(
				key,
				{ link: grant.link, code: grant.code },
				async (signal) => {
					try {
						const selectionSignal = ownerLocator(deps).selectionSignal;
						const { token } = await awaitVercelDeviceToken(grant, {
							fetch: http,
							signal: selectionSignal
								? AbortSignal.any([signal, selectionSignal])
								: signal,
							clock: {
								now: deps.now ?? SYSTEM_CLOCK.now,
								sleep:
									deps.sleep !== undefined
										? (ms) => deps.sleep?.(ms) ?? Promise.resolve()
										: SYSTEM_CLOCK.sleep,
							},
						});
						const teamId = await vercelDeviceTeam(
							token,
							plainEnv.HOBO_CD_VERCEL_TEAM_ID,
							http,
						);
						const values = {
							HOBO_CD_VERCEL_TOKEN: token,
							HOBO_CD_VERCEL_TEAM_ID: teamId,
							HOBO_CD_VERCEL_INSTALLATION_ID: VERCEL_DEVICE_INSTALLATION,
						} satisfies Readonly<
							Record<(typeof VERCEL_CONNECTION_KEYS)[number], string>
						>;
						await withStoreWriteLock(store, async () => {
							for (const name of VERCEL_CONNECTION_KEYS)
								await store.port.put(name, values[name]);
						});
						return { state: "done" };
					} catch (error) {
						if (error instanceof VercelDeviceError)
							return {
								state: "failed",
								code: error.code,
								message: error.message,
							};
						const why =
							error instanceof Error ? storeFailureReason(error) : undefined;
						return {
							state: "failed",
							code: "HOBO_CD_SECRET_STORE_UNAVAILABLE",
							message: `Could not keep the Vercel connection in ${store.id}${why === undefined ? "" : ` (${why})`}.`,
						};
					}
				},
			);
			if (!started) {
				// Another call started while this one requested its device grant.
				// Only the accepted grant gets a prompt and can be polled.
				const active = jobs.status(key);
				if (active?.state === "pending")
					return (
						(await viaForm(active.link, active.code)) ??
						awaiting(active.link, active.code)
					);
				if (active?.state === "failed")
					return refused(active.code, active.message, [
						"Run hobo cd up --hand-off again for a new code.",
					]);
				if (active?.state === "done") {
					let current: StoredVercelConnection | undefined;
					try {
						current = await readVercelConnection(store);
					} catch {
						// The completed connection must be read before it can be used.
					}
					if (current === undefined)
						return refused(
							"HOBO_CD_SECRET_STORE_UNAVAILABLE",
							"The completed Vercel connection is not readable yet.",
							["Check store access and retry."],
						);
					const expected = current;
					return ready(
						store,
						"unchanged",
						vault,
						deps.journalProvisioners,
						(next) => sameVercelConnection(expected, next),
					);
				}
				throw new Error("owner job rejected without a pending grant");
			}
			const asked = await viaForm(grant.link, grant.code);
			if (asked !== undefined) return asked;
			void deps.ownerChannel
				?.show?.(
					grant.link,
					`Approve HoBo CD on Vercel; the code is ${grant.code}.`,
					key,
				)
				.catch(() => undefined);
			return awaiting(grant.link, grant.code);
		}
		try {
			const { token } = await vercelDeviceToken({
				fetch: http,
				...(plainEnv.HOBO_CD_VERCEL_DEVICE_CLIENT_ID
					? { clientId: plainEnv.HOBO_CD_VERCEL_DEVICE_CLIENT_ID }
					: undefined),
				emit: (line) => input.run.emitProgress(line),
				...(deps.sleep !== undefined ? { sleep: deps.sleep } : undefined),
			});
			const teamId = await vercelDeviceTeam(
				token,
				plainEnv.HOBO_CD_VERCEL_TEAM_ID,
				http,
			);
			const values = {
				HOBO_CD_VERCEL_TOKEN: token,
				HOBO_CD_VERCEL_TEAM_ID: teamId,
				HOBO_CD_VERCEL_INSTALLATION_ID: VERCEL_DEVICE_INSTALLATION,
			} satisfies Readonly<
				Record<(typeof VERCEL_CONNECTION_KEYS)[number], string>
			>;
			await withStoreWriteLock(store, async () => {
				for (const key of VERCEL_CONNECTION_KEYS)
					await store.port.put(key, values[key]);
			});
			const expected: StoredVercelConnection = {
				token,
				teamId,
				installationId: VERCEL_DEVICE_INSTALLATION,
			};
			return ready(store, "created", vault, deps.journalProvisioners, (c) =>
				sameVercelConnection(expected, c),
			);
		} catch (error) {
			if (error instanceof VercelDeviceError)
				return refused(error.code, error.message, [
					"Run hobo cd up --hand-off again for a new code.",
				]);
			const why =
				error instanceof Error ? storeFailureReason(error) : undefined;
			return refused(
				"HOBO_CD_SECRET_STORE_UNAVAILABLE",
				`Could not keep the Vercel connection in ${store.id}${why === undefined ? "" : ` (${why})`}.`,
				[`Fix access to ${store.id} and run hobo cd up --hand-off again.`],
			);
		}
	}
	if (!canReachOwner(deps.interactive, input.handOff))
		return refused(
			"HOBO_CD_CONNECTION_NEEDS_OWNER",
			"Connecting Vercel needs the owner at a browser once; this run cannot show the setup page.",
			[
				"Run hobo cd up once in a terminal; it asks for what is missing and keeps it in your secret store.",
				"An agent can run hobo cd up --hand-off with a store that opens without a page; the owner approves Vercel using a device code.",
				`For CI, preconfigure an Infisical machine identity with OIDC Auth (INFISICAL_IDENTITY_ID, a non-secret setting) so the run signs in with its own OIDC token.`,
			],
		);

	let vercel: ReturnType<typeof createVercelConnectFlow> | undefined;
	let connectedStore: OpenedSecretStore | undefined;
	let selectedConnection: StoredVercelConnection | undefined;
	const unavailableFlow = (): ConnectFlow => ({
		initial: {
			kind: "failed",
			provider: "vercel",
			message:
				"Cannot verify the existing Vercel connection in the secret store.",
			remediation: [
				"Check store access and reconcile any partial credentials before retrying.",
			],
		},
		onAction: async (_action, _params, current) => ({ step: current }),
	});
	// The page must listen on the Redirect URL before the store is open, so it
	// comes from a non-secret setting of this run, not from the store.
	const redirect = parseVercelRedirect(
		plainEnv.HOBO_CD_VERCEL_REDIRECT_URI ?? DEFAULT_VERCEL_REDIRECT_URI,
	);
	if (redirect === undefined)
		return refused(
			"HOBO_CD_REDIRECT_INVALID",
			"The Integration's Redirect URL must be a loopback URL with a port (http://127.0.0.1:<port>/<path>).",
			[
				`Register ${DEFAULT_VERCEL_REDIRECT_URI} as the Integration's Redirect URL, or set HOBO_CD_VERCEL_REDIRECT_URI to the one it has.`,
			],
		);
	const redirectUri = redirect.href;
	const vercelFlowIn = async (
		store: OpenedSecretStore,
		values: Readonly<Record<string, string>>,
	): Promise<ConnectFlow> => {
		connectedStore = store;
		vercel = createVercelConnectFlow({
			integrationSlug: values.HOBO_CD_VERCEL_INTEGRATION ?? "",
			clientId: values.HOBO_CD_VERCEL_CLIENT_ID ?? "",
			redirectUri,
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

	const flow = await owner.stage({
		provider: "vercel",
		reason:
			"hobo cd up keeps the access Vercel grants, the Integration's client secret and what you tell it here in your secret store.",
		async proceed(store) {
			connectedStore = store;
			let alreadyConnected: StoredVercelConnection | undefined;
			try {
				alreadyConnected = await readVercelConnection(store);
			} catch {
				return unavailableFlow();
			}
			if (alreadyConnected) {
				selectedConnection = alreadyConnected;
				return {
					initial: {
						kind: "connected",
						provider: "vercel",
						store: store.id,
						references: [store.reference("HOBO_CD_VERCEL_TOKEN")],
						nextHint: "hobo cd up continues in your terminal.",
						link: undefined,
					},
					onAction: async (_action, _params, current) => ({ step: current }),
				};
			}
			const settings = familySettings(store, "cd");
			const basics = resolveSettings(
				CD_SETTINGS,
				plainEnv,
				await settings.read(),
			);
			let secretRead: Awaited<ReturnType<typeof store.port.access>>;
			try {
				secretRead = await store.port.access(VERCEL_CLIENT_SECRET_KEY);
			} catch {
				return unavailableFlow();
			}
			if (secretRead.status !== "ok" && secretRead.code !== "secret-not-found")
				return unavailableFlow();
			const hasSecret =
				secretRead.status === "ok" && Boolean(secretRead.material);
			if (secretRead.status === "ok" && !hasSecret) return unavailableFlow();
			const stageSettings = hasSecret
				? CD_SETTINGS
				: [...CD_SETTINGS, CLIENT_SECRET_SETTING];
			const stageMissing = hasSecret
				? basics.missing
				: [...basics.missing, CLIENT_SECRET_SETTING.field];
			return configureThen({
				provider: "vercel",
				title: "Set up HoBo CD on Vercel",
				reason:
					"hobo cd up needs HoBo CD's Vercel Integration. Answers are kept in your secret store; the client secret goes only there.",
				settings: stageSettings,
				missing: stageMissing,
				known: basics.values,
				store: settings,
				async proceed(values) {
					const asked = values.HOBO_CD_VERCEL_REDIRECT_URI;
					if (
						asked !== undefined &&
						parseVercelRedirect(asked)?.href !== redirectUri
					)
						return {
							ok: false,
							errors: {
								HOBO_CD_VERCEL_REDIRECT_URI: `This run serves ${redirectUri}; register it as the Integration's Redirect URL, or run with HOBO_CD_VERCEL_REDIRECT_URI set to the one it has.`,
							},
						};
					const secret = values.HOBO_CD_VERCEL_CLIENT_SECRET;
					if (secret !== undefined && secret !== "") {
						try {
							await store.port.put(VERCEL_CLIENT_SECRET_KEY, secret);
						} catch {
							return {
								ok: false,
								errors: {
									HOBO_CD_VERCEL_CLIENT_SECRET: `Could not write it to ${store.id}.`,
								},
							};
						}
					}
					return { ok: true, flow: await vercelFlowIn(store, values) };
				},
			});
		},
	});

	const page: ConnectPage = await (deps.startPage ?? startConnectPage)({
		flow,
		port: Number(redirect.port),
		callbackPath: redirect.pathname,
	});
	const step = await runPage(
		page,
		"vercel",
		deps.timeoutMs ?? 15 * 60_000,
		"hobo cd up",
		() =>
			showOwnerPage({
				url: page.url,
				what: "Set up Vercel for HoBo CD",
				handOff: input.handOff,
				emit: (line) => input.run.emitProgress(line),
				openBrowser: deps.openBrowser ?? openInBrowser,
			}),
	);
	if (step.kind !== "connected" || connectedStore === undefined)
		return refused(
			"HOBO_CD_VERCEL_NOT_CONNECTED",
			step.kind === "failed" ? step.message : "Vercel was not connected.",
			step.kind === "failed" ? step.remediation : [],
		);
	const selected = selectedConnection;
	const matches =
		vercel?.matchesConnection ??
		(selected
			? (current: StoredVercelConnection) =>
					sameVercelConnection(selected, current)
			: undefined);
	if (matches === undefined)
		return refused(
			"HOBO_CD_VERCEL_NOT_CONNECTED",
			"Vercel connection evidence is missing.",
			["Run hobo cd up again."],
		);
	return ready(
		connectedStore,
		vercel?.outcome() ?? "unchanged",
		vault,
		deps.journalProvisioners,
		matches,
	);
}
