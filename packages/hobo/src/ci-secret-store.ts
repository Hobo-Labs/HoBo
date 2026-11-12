// `hobo ci secret-store plan|provision` — choose the hosted relay's
// config/secret store when the deployment runs, provision it, and hand it to
// the owner by claim (ADR-0179 amendment "Secret store chosen at deploy,
// provisioned by claim"; `@hobo/secret-store-claim`).
//
// Nothing is pre-provisioned by hand and nothing lands in Vercel or GitHub
// secrets or variables. The store's coordinates (ids and an origin, no
// credential) are written to `deploy/secret-store.binding.json` in the relay's
// project, which `hobo ci deploy` and the deploy workflow read instead of
// repository variables. Bearer material (a claim URL, a sealed sign-in) goes
// only into the owner-only one-time action store under HOBO_HOME, and the
// owner reveals it in their own terminal with `hobo claim open secret-store`.
// This command never prints it.
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

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { create } from "@bufbuild/protobuf";
import { parseSessionBinding } from "@hobo/auth-md";
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
	CLOUDFLARE_DELETION_GRACE_MS,
	CLOUDFLARE_PROVIDER_ID,
	type CloudflareStoreReceipt,
	claimScopeFor,
	configServiceWorkerModules,
	DEFAULT_SECRET_STORE_OFFERS,
	formatSecretStoreBinding,
	type ParsedSecretStoreBinding,
	type ParsedSecretStoreEvidence,
	parseSecretStoreEvidence,
	parseSecretStoreKind,
	probeAuthMdStore,
	provisionAuthMdStore,
	provisionCloudflareTemporaryStore,
	provisionSelfHostedInfisical,
	readSecretStoreBinding,
	relayStoreLayout,
	SECRET_STORE_BINDING_FILE,
	SECRET_STORE_CLAIM_ITEM,
	SELF_HOSTED_PROVIDER_ID,
	SecretStoreError,
	SecretStoreEvidenceSchema,
	type SecretStoreKind,
	selectSecretStore,
	verifyCloudflareTemporaryClaim,
	verifySelfHostedInfisicalClaim,
} from "@hobo/secret-store-claim";

import { defaultHoboHome } from "./bare-metal-yard.js";
import { loadRelayYard } from "./ci-relay-yard.js";
import { applyClaimCommand, rebuildClaimState } from "./claim-plane.js";
import { isJsonString } from "./json.js";
import { createFileOneTimeActionStore } from "./one-time-action-store-file.js";

// The options of `hobo ci secret-store`, as `parseCiArgs` names them.
export const CI_SECRET_STORE_OPTIONS = [
	"auth-md",
	"fleet-host",
	"owner-email",
	"team",
	"vercel-team-slug",
	"vercel-project-id",
	"repo",
	"allow-designed",
	"offer",
	"experiment-worker",
	"home",
] as const;

// The ones no other `hobo ci` command takes.
export const SECRET_STORE_ONLY_OPTIONS = [
	"auth-md",
	"fleet-host",
	"owner-email",
	"vercel-team-slug",
	"vercel-project-id",
	"allow-designed",
	"offer",
	"experiment-worker",
] as const;

// The settings the relay's config-service binding asks the deploy for, and
// where in the binding each comes from.
export const SECRET_STORE_DEPLOY_INPUTS = Object.freeze({
	INFISICAL_SITE_URL: "endpoint",
	INFISICAL_IDENTITY_ID: "relayIdentityId",
	INFISICAL_PROJECT_ID: "projectId",
} as const);

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

/**
 * The committed binding of the relay project at `cwd`, or undefined when
 * the store has not been chosen yet. A binding the relay cannot read (a
 * designed runtime) or a malformed file is refused, never skipped.
 */
export function loadSecretStoreBinding(
	cwd: string,
): ParsedSecretStoreBinding | undefined {
	const file = path.join(cwd, SECRET_STORE_BINDING_FILE);
	if (!existsSync(file)) return undefined;
	let binding: ParsedSecretStoreBinding;
	try {
		binding = readSecretStoreBinding(readFileSync(file, "utf8"));
	} catch {
		throw new SecretStoreBindingRefusal(
			"HOBO_CI_SECRET_STORE_BINDING_INVALID",
			`${SECRET_STORE_BINDING_FILE} is not a valid secret store binding (coordinates only). Run hobo ci secret-store provision again.`,
		);
	}
	if (!RUNTIME_BUILT.has(binding.kind))
		throw new SecretStoreBindingRefusal(
			"HOBO_CI_SECRET_STORE_RUNTIME_UNBUILT",
			`${SECRET_STORE_BINDING_FILE} binds a ${binding.kind} store, which the relay cannot read yet.`,
		);
	return binding;
}

/** The deploy inputs a binding fills: names to non-secret values. */
export function secretStoreDeployInputs(
	binding: ParsedSecretStoreBinding,
): ReadonlyMap<string, string> {
	return new Map(
		Object.entries(SECRET_STORE_DEPLOY_INPUTS).map(([name, field]) => [
			name,
			binding[field],
		]),
	);
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
}

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
			isJsonString(input.env.INFISICAL_TOKEN) &&
			input.env.INFISICAL_TOKEN !== ""
				? evidence("infisical-cloud-attach", true)
				: evidence(
						"infisical-cloud-attach",
						false,
						"the owner is not signed in to Infisical (INFISICAL_TOKEN from infisical login)",
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

async function writeBinding(
	cwd: string,
	binding: ParsedSecretStoreBinding,
): Promise<string> {
	const file = path.join(cwd, SECRET_STORE_BINDING_FILE);
	const temporary = `${file}.${randomUUID()}.tmp`;
	await mkdir(path.dirname(file), { recursive: true });
	try {
		await writeFile(temporary, formatSecretStoreBinding(binding), {
			flag: "wx",
		});
		await rename(temporary, file);
	} finally {
		await rm(temporary, { force: true });
	}
	return SECRET_STORE_BINDING_FILE;
}

function claimSteps(kind: string, cwd: string): readonly string[] {
	const where = `--cwd ${cwd}`;
	switch (kind) {
		case "cloudflare-temporary":
			return [
				`Within 60 minutes: run \`hobo claim open ${SECRET_STORE_CLAIM_ITEM} ${where}\` in your own terminal and open the Cloudflare claim link it prints; sign in or sign up, and claim the account. Cloudflare deletes an unclaimed account and everything in it at the deadline.`,
				`This is the claim-link experiment, not the relay's store: the relay keeps Infisical, and nothing about its deployment changed.`,
				`With --experiment-worker, run \`hobo claim finalize ${SECRET_STORE_CLAIM_ITEM} ${where}\` no sooner than ${CLOUDFLARE_DELETION_GRACE_MS / 60_000} minutes after the deadline: Cloudflare offers no claim status, so HoBo verifies by the Worker still answering once an unclaimed account would be gone.`,
			];
		case "auth-md":
			return [
				`Run \`hobo claim open ${SECRET_STORE_CLAIM_ITEM} ${where}\` in your own terminal and approve the agent on the store's claim page before its deadline.`,
			];
		case "infisical-self-hosted":
			return [
				`Run \`hobo claim open ${SECRET_STORE_CLAIM_ITEM} ${where}\` in your own terminal: it shows your Infisical sign-in once. Sign in, then change the password and turn on MFA.`,
				`Then run \`hobo claim finalize ${SECRET_STORE_CLAIM_ITEM} ${where}\`: HoBo deletes its own bootstrap identity and checks that Infisical refuses its token.`,
				`Commit ${SECRET_STORE_BINDING_FILE} (coordinates only) so hobo ci deploy and the deploy workflow find the store.`,
			];
		default:
			return [
				`Commit ${SECRET_STORE_BINDING_FILE} (coordinates only) so hobo ci deploy and the deploy workflow find the store.`,
			];
	}
}

export async function runCiSecretStore(
	input: CiSecretStoreInput,
): Promise<CommandResult> {
	if (input.subcommand !== "plan" && input.subcommand !== "provision")
		return usage(
			"Use hobo ci secret-store plan or hobo ci secret-store provision.",
		);
	const now = new Date(input.now?.() ?? Date.now());
	const named = text(input.values, "offer");
	let only: SecretStoreKind | undefined;
	try {
		only = named === undefined ? undefined : parseSecretStoreKind(named);
	} catch {
		return usage(
			`--offer is one of ${DEFAULT_SECRET_STORE_OFFERS.map((offer) => offer.kind).join(", ")}.`,
		);
	}
	if (
		input.values["experiment-worker"] === true &&
		only !== "cloudflare-temporary"
	)
		return usage(
			"--experiment-worker applies to --offer cloudflare-temporary only.",
		);
	const gathered = await gatherEvidence(input);
	let route: ReturnType<typeof selectSecretStore>;
	try {
		route = selectSecretStore({
			offers: DEFAULT_SECRET_STORE_OFFERS,
			evidence: gathered.evidence,
			allowDesigned: input.values["allow-designed"] === true,
			...(only !== undefined ? { only } : undefined),
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
	// Refuse before anything is created: a provider account made without a Yard
	// runtime would leave its claim sealed but attached to nothing.
	if (input.runtime === undefined)
		return refused(
			"HOBO_NO_RUNTIME",
			"hobo ci secret-store provision has no Yard runtime wired — run it from the composed hobo binary.",
		);
	const deploymentRef = deploymentIdFor(input.cwd);
	const home = text(input.values, "home") ?? defaultHoboHome({ ...input.env });
	const store = createFileOneTimeActionStore({ home });
	const scope = claimScopeFor(deploymentRef, input.env);
	const send = input.fetch ?? fetch;
	try {
		let bundle: ClaimBundle | undefined;
		let binding: ParsedSecretStoreBinding | undefined;
		let experiment: CloudflareStoreReceipt | undefined;
		if (kind === "infisical-self-hosted" || kind === "infisical-cloud-attach") {
			const teamId = text(input.values, "team");
			const teamSlug = text(input.values, "vercel-team-slug");
			const projectId = text(input.values, "vercel-project-id");
			const yard = await loadRelayYard(input.cwd);
			const yardRepo = yard?.properties.repository;
			const repository =
				text(input.values, "repo") ??
				(isJsonString(yardRepo) ? yardRepo : undefined);
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
			const layout = relayStoreLayout({
				vercelTeamSlug: teamSlug,
				vercelTeamId: teamId,
				vercelProjectId: projectId,
				...(isJsonString(yardProject)
					? { vercelProjectName: yardProject }
					: undefined),
				repository,
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
					layout,
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
			} else {
				binding = await attachInfisicalCloud({
					...(input.env.INFISICAL_SITE_URL
						? { siteUrl: input.env.INFISICAL_SITE_URL }
						: undefined),
					ownerAccessToken: input.env.INFISICAL_TOKEN ?? "",
					layout,
					deploymentRef,
					now,
					fetch: send,
					...(input.allowLoopback === true
						? { allowLoopback: true }
						: undefined),
				});
			}
		} else if (kind === "cloudflare-temporary") {
			const withWorker = input.values["experiment-worker"] === true;
			const teamId = text(input.values, "team");
			const teamSlug = text(input.values, "vercel-team-slug");
			const projectId = text(input.values, "vercel-project-id");
			const yard = withWorker ? await loadRelayYard(input.cwd) : undefined;
			const yardRepo = yard?.properties.repository;
			const yardProject = yard?.properties.project;
			const repository =
				text(input.values, "repo") ??
				(isJsonString(yardRepo) ? yardRepo : undefined);
			if (
				withWorker &&
				(teamId === undefined ||
					teamSlug === undefined ||
					projectId === undefined ||
					repository === undefined)
			)
				return usage(
					"--experiment-worker needs --team <team_id>, --vercel-team-slug <slug>, --vercel-project-id <prj_id> and a repository (--repo or the Yard's): the Worker's binding names who may read and write it.",
				);
			// The owner types the word: a keypress is not acceptance of terms.
			const answer = await input.prompt(
				[
					"EXPERIMENT: HoBo will create a temporary Cloudflare account to prove it can hand you a claim link.",
					"It is not the relay's secret store; the relay keeps Infisical and its Vercel project.",
					withWorker
						? "HoBo will also upload its config-service Worker (a Durable Object) into the account."
						: "Nothing is deployed into the account.",
					"You must claim it within 60 minutes or Cloudflare deletes it.",
					`Cloudflare Terms of Service: ${CLOUDFLARE_TERMS_URL}`,
					`Cloudflare Privacy Policy: ${CLOUDFLARE_PRIVACY_URL}`,
					'To accept both, type "accept": ',
				].join("\n"),
			);
			const accepted = answer.trim().toLowerCase() === "accept";
			const provisioned = await provisionCloudflareTemporaryStore({
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
				...(withWorker &&
				teamId !== undefined &&
				teamSlug !== undefined &&
				projectId !== undefined &&
				repository !== undefined
					? {
							worker: {
								modules: await configServiceWorkerModules(),
								binding: {
									vercelTeamSlug: teamSlug,
									vercelTeamId: teamId,
									vercelProjectName: isJsonString(yardProject)
										? yardProject
										: "hobo-ci",
									vercelProjectId: projectId,
									repository,
								},
								fetch: send,
							},
						}
					: undefined),
			});
			bundle = provisioned.bundle;
			experiment = provisioned.receipt;
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
				? await writeBinding(input.cwd, binding)
				: undefined;
		const steps = claimSteps(kind, input.cwd);
		return {
			ok: true,
			status: bundle !== undefined ? "claim_pending" : "provisioned",
			code: "HOBO_CI_SECRET_STORE_PROVISIONED",
			message: [
				summary,
				written !== undefined
					? `Wrote ${written} (coordinates only).`
					: `The relay cannot read a ${kind} store yet; no binding was written.`,
				...(experiment?.worker === undefined
					? []
					: [
							experiment.worker.outcome === "serving"
								? `The config-service Worker is serving at ${experiment.worker.origin} (store ${experiment.worker.storeId}), seeded empty.`
								: `The config-service Worker experiment failed at ${experiment.worker.stage} (${experiment.worker.code}); the account and its claim link are still yours to claim.`,
						]),
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
								endpoint: binding.endpoint,
								projectId: binding.projectId,
								claimState: binding.claimState,
								file: SECRET_STORE_BINDING_FILE,
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
				...(experiment !== undefined
					? {
							experiment: {
								accountId: experiment.accountId,
								claimDeadline: new Date(
									experiment.claimDeadlineMs,
								).toISOString(),
								...(experiment.worker !== undefined
									? { worker: { ...experiment.worker } }
									: undefined),
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
		if (input.item.providerId === CLOUDFLARE_PROVIDER_ID) {
			try {
				return await verifyCloudflareTemporaryClaim({
					verificationRef: input.item.verificationRef,
					deadlineMs: input.item.deadline,
					nowMs: input.nowMs,
					...(deps.fetch !== undefined ? { fetch: deps.fetch } : undefined),
				});
			} catch (error) {
				if (error instanceof SecretStoreError)
					throw new ClaimError("CLAIM_NOT_VERIFIED", error.message);
				throw error;
			}
		}
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
