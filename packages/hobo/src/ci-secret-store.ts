// `hobo ci secret-store plan|provision|connect|verify` — choose the hosted relay's
// config/secret store when the deployment runs, provision it, and hand it to
// the owner by claim (ADR-0179 amendment "Secret store chosen at deploy,
// provisioned by claim"; `@hobo/secret-store-claim`).
//
// Evidence, per offer, gathered here:
// - auth-md: each `--auth-md <origin>` is probed for auth.md metadata that
//   advertises anonymous registration;
// - cloudflare-temporary: an interactive terminal, where the owner can accept
//   Cloudflare's Terms of Service and Privacy Policy;
// - infisical-self-hosted: `--fleet-host <origin>`, a fresh Infisical the
//   Yard placed on a compute fleet host;
// - infisical-cloud-attach: INFISICAL_TOKEN in the environment, from the
//   owner's own `infisical login`.
//
// HONEST SCOPE: exercised against local stand-ins only.

import { create } from "@bufbuild/protobuf";
import { parseSessionBinding } from "@hobo/auth-md";
import type { CredentialResolver } from "@hobo/cd";
import type { ClaimBundle, ClaimItem } from "@hobo/claims";
import { ClaimError } from "@hobo/claims";
import type { CommandResult, YardRuntime } from "@hobo/cli";
import { deploymentIdFor } from "@hobo/cli";
import {
	CLOUDFLARE_PRIVACY_URL,
	CLOUDFLARE_TERMS_URL,
	type TemporaryAccountTransportPort,
} from "@hobo/provider-cloudflare";
import {
	attachInfisicalCloud,
	claimScopeFor,
	DEFAULT_SECRET_STORE_OFFERS,
	formatSecretStoreBinding,
	type ParsedSecretStoreBinding,
	type ParsedSecretStoreEvidence,
	parseSecretStoreEvidence,
	probeAuthMdStore,
	provisionAuthMdStore,
	provisionCloudflareTemporaryStore,
	provisionSelfHostedInfisical,
	readSecretStoreBinding,
	relayStoreLayout,
	SECRET_STORE_BINDING_ENTRY,
	SECRET_STORE_CLAIM_ITEM,
	SELF_HOSTED_PROVIDER_ID,
	SecretStoreError,
	SecretStoreEvidenceSchema,
	selectSecretStore,
	verifySelfHostedInfisicalClaim,
} from "@hobo/secret-store-claim";

import { defaultHoboHome } from "./bare-metal-yard.js";
import { loadRelayYard } from "./ci-relay-yard.js";
import {
	runCiSecretStoreConnect,
	runCiSecretStoreVerify,
} from "./ci-secret-store-connect.js";
import {
	relayRepository,
	resolveDeploySubject,
} from "./ci-secret-store-github.js";
import { applyClaimCommand, rebuildClaimState } from "./claim-plane.js";
import { isJsonString } from "./json.js";
import { createFileOneTimeActionStore } from "./one-time-action-store-file.js";
import {
	OwnerCredentialUnavailable,
	type OwnerStoreEntries,
} from "./owner-store-session.js";

// The options of `hobo ci secret-store`, as `parseCiArgs` names them.
export const CI_SECRET_STORE_OPTIONS = [
	"project-id",
	"deploy-project-id",
	"relay-identity-id",
	"deploy-identity-id",
	"deploy-credential-identity-id",
	"identity",
	"site-url",
	"environment",
	"yes",
	"auth-md",
	"fleet-host",
	"owner-email",
	"team",
	"vercel-team-slug",
	"vercel-project-id",
	"repo",
	"allow-designed",
	"home",
] as const;

// The ones no other `hobo ci` command takes.
export const SECRET_STORE_ONLY_OPTIONS = [
	"deploy-project-id",
	"relay-identity-id",
	"deploy-identity-id",
	"deploy-credential-identity-id",
	"identity",
	"site-url",
	"auth-md",
	"fleet-host",
	"owner-email",
	"vercel-team-slug",
	"vercel-project-id",
	"allow-designed",
] as const;

const RUNTIME_BUILT = new Set([
	"infisical-self-hosted",
	"infisical-cloud-attach",
]);

export class SecretStoreBindingRefusal extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "SecretStoreBindingRefusal";
		this.code = code;
	}
}

// public-contract: the refusal when the owner's store session that holds the coordinates is not established.
export const SECRET_STORE_SESSION_REQUIRED =
	"HOBO_CI_SECRET_STORE_SESSION_REQUIRED";

const SESSION_REQUIRED_MESSAGE =
	"The relay's store coordinates live only in the owner's secret store, never in the repository or the environment. Connect it with HoBo MCP's choose_secret_store (cwd: this project), then run again.";

export interface SecretStoreBindingStore {
	read(): Promise<string | undefined>;
	write(text: string): Promise<void>;
}

function sessionRequired(): SecretStoreBindingRefusal {
	return new SecretStoreBindingRefusal(
		SECRET_STORE_SESSION_REQUIRED,
		SESSION_REQUIRED_MESSAGE,
	);
}

async function withinSession<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (
			error instanceof OwnerCredentialUnavailable &&
			error.reason === "no-session"
		)
			throw sessionRequired();
		throw error;
	}
}

export function ownerSecretStoreBindingStore(
	entries: OwnerStoreEntries,
): SecretStoreBindingStore {
	return Object.freeze({
		read: () => withinSession(() => entries.read(SECRET_STORE_BINDING_ENTRY)),
		write: (text: string) =>
			withinSession(() => entries.write(SECRET_STORE_BINDING_ENTRY, text)),
	});
}

export function requireSecretStoreBindingStore(
	store: SecretStoreBindingStore | undefined,
): SecretStoreBindingStore {
	if (store === undefined) throw sessionRequired();
	return store;
}

export async function readSecretStoreBindingText(
	store: SecretStoreBindingStore | undefined,
): Promise<string | undefined> {
	return requireSecretStoreBindingStore(store).read();
}

export async function loadSecretStoreBinding(
	store: SecretStoreBindingStore | undefined,
): Promise<ParsedSecretStoreBinding | undefined> {
	const text = await readSecretStoreBindingText(store);
	return text === undefined ? undefined : parseOwnerStoreBinding(text);
}

export function parseOwnerStoreBinding(text: string): ParsedSecretStoreBinding {
	let binding: ParsedSecretStoreBinding;
	try {
		binding = readSecretStoreBinding(text);
	} catch {
		throw new SecretStoreBindingRefusal(
			"HOBO_CI_SECRET_STORE_BINDING_INVALID",
			"The owner store's secret store binding is not valid (coordinates only). A deploy credential needs both a deploy project other than the relay's, a deploy credential identity distinct from the relay and writer identities, and the writer's deploy subject; re-run hobo ci secret-store connect through the owner hand-off to configure one.",
		);
	}
	if (!RUNTIME_BUILT.has(binding.kind))
		throw new SecretStoreBindingRefusal(
			"HOBO_CI_SECRET_STORE_RUNTIME_UNBUILT",
			`The owner store's binding names a ${binding.kind} store, which the relay cannot read yet.`,
		);
	return binding;
}

type Values = Readonly<
	Record<string, string | boolean | readonly string[] | undefined>
>;

function text(values: Values, key: string): string | undefined {
	const value = values[key];
	return isJsonString(value) && value !== "" ? value : undefined;
}

function list(values: Values, key: string): readonly string[] {
	const value = values[key];
	if (Array.isArray(value)) return value.filter(isJsonString);
	return isJsonString(value) && value !== "" ? [value] : [];
}

function evidence(
	kind: string,
	available: boolean,
	detail = "",
): ParsedSecretStoreEvidence {
	return parseSecretStoreEvidence(
		create(SecretStoreEvidenceSchema, { kind, available, detail }),
	);
}

function usage(message: string): CommandResult {
	return {
		ok: false,
		status: "usage",
		code: "HOBO_CI_SECRET_STORE_USAGE",
		message,
		data: { command: "ci secret-store" },
	};
}

function refused(code: string, message: string): CommandResult {
	return {
		ok: false,
		status: "refused",
		code,
		message,
		data: { command: "ci secret-store" },
	};
}

// A fetch-backed transport for the Cloudflare provider package: bounded
// body, a deadline, no redirects. The provider package checks the host.
export function fetchTemporaryAccountTransport(
	send: typeof fetch,
): TemporaryAccountTransportPort {
	return {
		async send(request) {
			const response = await send(request.url, {
				method: request.method,
				headers: request.headers,
				...(request.body !== undefined ? { body: request.body } : undefined),
				redirect: "error",
				signal: AbortSignal.timeout(request.timeoutMs),
			});
			const reader = response.body?.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			let truncated = false;
			if (reader !== undefined) {
				for (;;) {
					const part = await reader.read();
					if (part.done) break;
					size += part.value.byteLength;
					if (size > request.maxResponseBytes) {
						truncated = true;
						void reader.cancel().catch(() => undefined);
						break;
					}
					chunks.push(part.value);
				}
			}
			const headers: Record<string, string> = {};
			response.headers.forEach((value, name) => {
				headers[name] = value;
			});
			return {
				status: response.status,
				headers,
				body: Buffer.concat(chunks).toString("utf8"),
				...(truncated ? { truncated } : undefined),
			};
		},
	};
}

export interface CiSecretStoreInput {
	readonly subcommand: string;
	readonly cwd: string;
	readonly values: Values;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly fetch?: typeof fetch;
	readonly runtime?: YardRuntime;
	readonly interactive: boolean;
	readonly prompt: (question: string) => Promise<string>;
	readonly now?: () => number;
	/** Tests: accept a loopback stand-in's http origin as a fleet host. */
	readonly allowLoopback?: boolean;
	readonly bindingStore?: SecretStoreBindingStore;
	readonly credentials?: CredentialResolver;
	readonly ownerInfisicalSession?: () => Promise<OwnerInfisicalSession>;
}

export type OwnerInfisicalSession =
	| { readonly ok: true; readonly session: string }
	| { readonly ok: false; readonly code: string; readonly message: string };

async function gatherEvidence(input: CiSecretStoreInput) {
	const send = input.fetch ?? fetch;
	const candidates = list(input.values, "auth-md");
	let authMd = evidence(
		"auth-md",
		false,
		"no candidate store named (--auth-md <origin>)",
	);
	let discovered: Awaited<ReturnType<typeof probeAuthMdStore>> | undefined;
	for (const resource of candidates) {
		const probe = await probeAuthMdStore({
			port: { fetchImpl: send },
			resource,
		});
		authMd = probe.evidence;
		if (probe.evidence.available) {
			discovered = probe;
			break;
		}
	}
	const fleetHost = text(input.values, "fleet-host");
	return {
		discovered,
		evidence: [
			authMd,
			input.interactive
				? evidence("cloudflare-temporary", true)
				: evidence(
						"cloudflare-temporary",
						false,
						"the owner must accept Cloudflare's terms in an interactive terminal",
					),
			fleetHost !== undefined
				? evidence("infisical-self-hosted", true)
				: evidence(
						"infisical-self-hosted",
						false,
						"no fresh Infisical on a compute fleet host (--fleet-host <origin>)",
					),
			// The default (ADR-0179 amendment "Secretless first"): the owner signs
			// up in Infisical's web app and creates the OIDC Auth identities there;
			// nothing HoBo runs needs a token for it. Naming a fleet host is the
			// owner choosing self-hosted Infisical instead.
			text(input.values, "fleet-host") === undefined
				? evidence("infisical-cloud-attach", true)
				: evidence(
						"infisical-cloud-attach",
						false,
						"the owner chose a self-hosted Infisical (--fleet-host)",
					),
		],
	};
}

async function attachBundle(
	runtime: YardRuntime | undefined,
	deploymentRef: string,
	bundle: ClaimBundle,
): Promise<void> {
	if (runtime === undefined)
		throw new SecretStoreBindingRefusal(
			"HOBO_NO_RUNTIME",
			"hobo ci secret-store provision has no Yard runtime wired — run it from the composed hobo binary.",
		);
	const snapshot = await rebuildClaimState(
		runtime,
		deploymentRef,
		`${deploymentRef}:0`,
	);
	if (snapshot.state.bundle !== undefined)
		throw new SecretStoreBindingRefusal(
			"HOBO_CI_SECRET_STORE_CLAIM_EXISTS",
			`A claim bundle already exists for ${deploymentRef}. Finish it with hobo claim status, open and finalize first.`,
		);
	await applyClaimCommand(runtime, snapshot, {
		kind: "AttachClaimBundle",
		bundle,
	});
}

export async function writeSecretStoreBinding(
	store: SecretStoreBindingStore | undefined,
	binding: ParsedSecretStoreBinding,
): Promise<string> {
	await requireSecretStoreBindingStore(store).write(
		formatSecretStoreBinding(binding),
	);
	return SECRET_STORE_BINDING_ENTRY;
}

function claimSteps(kind: string, cwd: string): readonly string[] {
	const where = `--cwd ${cwd}`;
	switch (kind) {
		case "cloudflare-temporary":
			return [
				`Within 60 minutes: run \`hobo claim open ${SECRET_STORE_CLAIM_ITEM} ${where}\` in your own terminal and open the Cloudflare claim link it prints; sign in or sign up, and claim the account. Cloudflare deletes an unclaimed account.`,
			];
		case "auth-md":
			return [
				`Run \`hobo claim open ${SECRET_STORE_CLAIM_ITEM} ${where}\` in your own terminal and approve the agent on the store's claim page before its deadline.`,
			];
		case "infisical-self-hosted":
			return [
				`Run \`hobo claim open ${SECRET_STORE_CLAIM_ITEM} ${where}\` in your own terminal: it shows your Infisical sign-in once. Sign in, then change the password and turn on MFA.`,
				`Then run \`hobo claim finalize ${SECRET_STORE_CLAIM_ITEM} ${where}\`: HoBo deletes its own bootstrap identity and checks that Infisical refuses its token.`,
				`The coordinates are in your secret store (${SECRET_STORE_BINDING_ENTRY}); hobo ci deploy reads them from the owner store session. Never commit or share them.`,
			];
		case "infisical-cloud-attach":
			return [
				"In Infisical's web app: sign up or in, create projects hobo-ci (folder /hobo-ci-relay) and hobo-ci-deploy in prod, and add three OIDC Auth machine identities: hobo-ci-relay (Vercel), hobo-ci-writer (GitHub Actions), and read-only hobo-ci-deploy-reader (GitHub Actions, in hobo-ci-deploy only). The hobo-deploy skill gives every value.",
				`In your own terminal, with your secret store connected (HoBo MCP's choose_secret_store), run \`hobo ci secret-store connect ${where} --repo <owner/name>\` with the ids from the dashboard. It writes them to your secret store as ${SECRET_STORE_BINDING_ENTRY}, never to the repository, and never prints them. Do not paste them into a chat or a commit.`,
			];
		default:
			return [
				`The coordinates stay in your secret store (${SECRET_STORE_BINDING_ENTRY}); hobo ci deploy reads them from the owner store session.`,
			];
	}
}

export async function runCiSecretStore(
	input: CiSecretStoreInput,
): Promise<CommandResult> {
	if (input.subcommand === "connect") return runCiSecretStoreConnect(input);
	if (input.subcommand === "verify") return runCiSecretStoreVerify(input);
	if (input.subcommand !== "plan" && input.subcommand !== "provision")
		return usage(
			"Use hobo ci secret-store plan, provision, connect or verify.",
		);
	const now = new Date(input.now?.() ?? Date.now());
	const gathered = await gatherEvidence(input);
	let route: ReturnType<typeof selectSecretStore>;
	try {
		route = selectSecretStore({
			offers: DEFAULT_SECRET_STORE_OFFERS,
			evidence: gathered.evidence,
			allowDesigned: input.values["allow-designed"] === true,
			now,
		});
	} catch (error) {
		if (error instanceof SecretStoreError)
			return refused(error.code, error.message);
		throw error;
	}
	const kind = route.offer.kind;
	const offers = DEFAULT_SECRET_STORE_OFFERS.map((offer) => ({
		kind: offer.kind,
		preference: offer.preference,
		claimMechanism: offer.claimMechanism,
		claimWindowMinutes: offer.claimWindowMinutes,
		runtimeBinding: offer.runtimeBinding,
		provider: offer.provider,
		// Secretless first: "stored-token" stores never hold the relay's runtime secrets.
		runtimeAuth: offer.runtimeAuth,
		cost: offer.cost,
		availability: offer.availability,
		source: `${offer.sourceUrl} (read ${offer.checkedAt})`,
	}));
	const selection = {
		capability: route.selection.capability,
		selected: kind,
		skipped: route.selection.skipped.map((skip) => ({
			kind: skip.kind,
			reason: skip.reason,
		})),
		decidedAt: route.selection.decidedAt,
	};
	const summary = [
		`secrets.config-service/v1 → ${kind} (${route.offer.claimMechanism})`,
		...selection.skipped.map(
			(skip) => `  passed over ${skip.kind}: ${skip.reason}`,
		),
	].join("\n");

	if (input.subcommand === "plan")
		return {
			ok: true,
			status: "planned",
			code: "HOBO_CI_SECRET_STORE_PLANNED",
			message: summary,
			data: {
				command: "ci secret-store",
				subcommand: "plan",
				selection,
				offers,
				claimSteps: [...claimSteps(kind, input.cwd)],
			},
		};

	// provision
	const deploymentRef = deploymentIdFor(input.cwd);
	const home = text(input.values, "home") ?? defaultHoboHome({ ...input.env });
	const store = createFileOneTimeActionStore({ home });
	const scope = claimScopeFor(deploymentRef, input.env);
	const send = input.fetch ?? fetch;
	try {
		let bundle: ClaimBundle | undefined;
		let binding: ParsedSecretStoreBinding | undefined;
		if (kind === "infisical-self-hosted" || kind === "infisical-cloud-attach") {
			const teamId = text(input.values, "team");
			const teamSlug = text(input.values, "vercel-team-slug");
			const projectId = text(input.values, "vercel-project-id");
			const yard = await loadRelayYard(input.cwd);
			const repository = await relayRepository(input.cwd, input.values);
			if (
				teamId === undefined ||
				teamSlug === undefined ||
				projectId === undefined ||
				repository === undefined
			)
				return usage(
					"hobo ci secret-store provision needs --team <team_id>, --vercel-team-slug <slug> and --vercel-project-id <prj_id> (the relay's identity trusts that project's OIDC tokens only), and a repository (--repo or the Yard's).",
				);
			const yardProject = yard?.properties.project;
			// The deploy trust uses the subject GitHub issues for the
			// repository; resolved only where a layout is provisioned.
			const layoutOf = async () =>
				relayStoreLayout({
					vercelTeamSlug: teamSlug,
					vercelTeamId: teamId,
					vercelProjectId: projectId,
					...(isJsonString(yardProject)
						? { vercelProjectName: yardProject }
						: undefined),
					github: await resolveDeploySubject({
						repository,
						credentials: input.credentials,
						fetch: send,
					}),
				});
			if (kind === "infisical-self-hosted") {
				const ownerEmail = text(input.values, "owner-email");
				if (ownerEmail === undefined)
					return usage(
						"A self-hosted store needs --owner-email: the address of the admin user the claim hands you.",
					);
				const result = await provisionSelfHostedInfisical({
					siteUrl: text(input.values, "fleet-host") ?? "",
					ownerEmail,
					organization: "hobo",
					layout: await layoutOf(),
					deploymentRef,
					store,
					scope,
					now,
					fetch: send,
					...(input.allowLoopback === true
						? { allowLoopback: true }
						: undefined),
				});
				bundle = result.bundle;
				binding = result.binding;
			} else if (
				!isJsonString(input.env.INFISICAL_TOKEN) ||
				input.env.INFISICAL_TOKEN === ""
			) {
				// No token: the default path. The owner creates the project and the
				// two OIDC Auth identities in the dashboard; connect records the ids.
				return {
					ok: true,
					status: "planned",
					code: "HOBO_CI_SECRET_STORE_CONNECT_IN_DASHBOARD",
					message: `${summary}\nInfisical Cloud with OIDC Auth: create the project and the identities in Infisical's web app (the hobo-deploy skill walks it, every value prefilled), then run hobo ci secret-store connect with their ids. No token is needed anywhere.`,
					data: {
						command: "ci secret-store",
						subcommand: "provision",
						selection,
						offers,
						claimSteps: [...claimSteps(kind, input.cwd)],
					},
				};
			} else {
				binding = await attachInfisicalCloud({
					...(input.env.INFISICAL_SITE_URL
						? { siteUrl: input.env.INFISICAL_SITE_URL }
						: undefined),
					ownerAccessToken: input.env.INFISICAL_TOKEN ?? "",
					layout: await layoutOf(),
					deploymentRef,
					now,
					fetch: send,
					...(input.allowLoopback === true
						? { allowLoopback: true }
						: undefined),
				});
			}
		} else if (kind === "cloudflare-temporary") {
			const answer = await input.prompt(
				`HoBo will create a temporary Cloudflare account for the relay's secret store, which you claim within 60 minutes.\nCloudflare Terms of Service: ${CLOUDFLARE_TERMS_URL}\nCloudflare Privacy Policy: ${CLOUDFLARE_PRIVACY_URL}\nDo you accept both? [y/N] `,
			);
			const accepted = /^y(es)?$/iu.test(answer.trim());
			bundle = (
				await provisionCloudflareTemporaryStore({
					transport: fetchTemporaryAccountTransport(send),
					consent: accepted
						? {
								subjectRef: `hobo-owner:${deploymentRef}`,
								termsUrl: CLOUDFLARE_TERMS_URL,
								privacyUrl: CLOUDFLARE_PRIVACY_URL,
								acceptedAtMs: now.getTime(),
								acceptanceMethod: "cli-confirmation",
							}
						: undefined,
					deploymentRef,
					store,
					scope,
					now,
				})
			).bundle;
		} else {
			const discovery = gathered.discovered?.discovery;
			const resource = discovery?.metadata.resource;
			if (discovery === undefined || resource === undefined)
				return refused(
					"SECRET_STORE_NO_OFFER",
					"No auth.md store was discovered.",
				);
			bundle = (
				await provisionAuthMdStore({
					port: { fetchImpl: send },
					discovery,
					binding: parseSessionBinding({
						sessionId: deploymentRef,
						tenantId: scope.tenantId,
						projectId: scope.projectId,
						audience: resource,
						service: resource,
					}),
					requestedScopes: discovery.effectiveScopes,
					deploymentRef,
					store,
					scope,
					now,
				})
			).bundle;
		}
		if (bundle !== undefined)
			await attachBundle(input.runtime, deploymentRef, bundle);
		const written =
			binding !== undefined
				? await writeSecretStoreBinding(input.bindingStore, binding)
				: undefined;
		const steps = claimSteps(kind, input.cwd);
		return {
			ok: true,
			status: bundle !== undefined ? "claim_pending" : "provisioned",
			code: "HOBO_CI_SECRET_STORE_PROVISIONED",
			message: [
				summary,
				written !== undefined
					? `Wrote the coordinates to your secret store as ${written}; they are not shown here.`
					: `The relay cannot read a ${kind} store yet; no binding was written.`,
				"Owner, next:",
				...steps.map((step, index) => `  ${index + 1}. ${step}`),
			].join("\n"),
			data: {
				command: "ci secret-store",
				subcommand: "provision",
				selection,
				...(binding !== undefined
					? {
							binding: {
								kind: binding.kind,
								claimState: binding.claimState,
								entry: SECRET_STORE_BINDING_ENTRY,
							},
						}
					: undefined),
				...(bundle !== undefined
					? {
							claim: {
								bundleId: bundle.id,
								item: SECRET_STORE_CLAIM_ITEM,
								deadline:
									bundle.earliestDeadline !== undefined
										? new Date(bundle.earliestDeadline).toISOString()
										: null,
							},
						}
					: undefined),
				claimSteps: [...steps],
			},
		};
	} catch (error) {
		if (
			error instanceof SecretStoreError ||
			error instanceof SecretStoreBindingRefusal
		)
			return refused(error.code, error.message);
		throw error;
	}
}

/**
 * `hobo claim finalize secret-store`: the provider verification for items
 * this package made. Self-hosted Infisical is verified through Infisical;
 * the other offers' verification is designed, and refused here.
 */
export function secretStoreOwnershipVerifier(deps: {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly fetch?: typeof fetch;
}) {
	return async (input: {
		readonly item: ClaimItem;
		readonly nowMs: number;
		readonly deploymentRef?: string;
		readonly home?: string;
	}): Promise<{ readonly verified: boolean; readonly evidenceRef: string }> => {
		if (input.item.providerId !== SELF_HOSTED_PROVIDER_ID)
			throw new ClaimError(
				"CLAIM_NOT_VERIFIED",
				`no provider verifier is built for ${input.item.providerId} claims yet`,
			);
		const deploymentRef = input.deploymentRef ?? "";
		return verifySelfHostedInfisicalClaim({
			item: input.item,
			store: createFileOneTimeActionStore({
				home: input.home ?? defaultHoboHome({ ...deps.env }),
			}),
			scope: claimScopeFor(deploymentRef, deps.env),
			nowMs: input.nowMs,
			...(deps.fetch !== undefined ? { fetch: deps.fetch } : undefined),
		});
	};
}
