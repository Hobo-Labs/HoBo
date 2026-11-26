/**
 * The effectful driver for `netlify.anonymous-static-site/v1`.
 *
 * What this driver is careful about:
 *
 * 1. The deploy is genuinely anonymous — no HoBo account, no HoBo money — but
 *    the site is *claimable*, and the claim URL that makes it claimable is
 *    bearer authority. It exists in one function scope, goes into custody and the
 *    one-time action store, and never reaches a record, receipt, event, or error.
 * 2. `netlify deploy` is not an idempotent API call. A retry creates a second
 *    site, so an attempt key is recorded before the CLI runs and a replay refuses
 *    to deploy again.
 * 3. A claim Netlify reports is not a finished hand-over. The site has to read
 *    back as owned by the claiming account, *and* the pre-claim anonymous
 *    material has to stop working — the second half is what usually gets skipped.
 * 4. The window is one hour and the provider owns it. Everything that can expire
 *    carries that deadline, and past it the honest answer is `CLAIM_EXPIRED`
 *    rather than a retry.
 */

import type { SecretRef } from "@hobo/bindings";
import type {
	ClaimCommand,
	ClaimCoordinatorState,
	Instant,
} from "@hobo/claims";
import { ClaimError, type OneTimeActionStore } from "@hobo/claims";

import {
	type AnonymousClaimPlan,
	compileAnonymousClaimPlan,
	NETLIFY_ANONYMOUS_BOOTSTRAP_STRATEGY_REF,
	NETLIFY_ANONYMOUS_CLAIM_STRATEGY_REF,
	NETLIFY_PROVIDER_ID,
	siteClaimItemId,
} from "./claim-plan.js";
import type { IdempotencyStore, NetlifyClient } from "./client.js";
import { depositSecret, type SecretCustodyPort } from "./custody.js";
import { NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID } from "./definitions.js";
import {
	type AnonymousDeployObservation,
	type ExpirySource,
	parseAnonymousDeployOutput,
} from "./deploy-output.js";
import { runIsolatedNetlifyAnonymousDeploy } from "./isolated-deploy.js";
import {
	NETLIFY_CLI_PACKAGE_SPEC,
	type ProcessRunner,
} from "./process-runner.js";
import { NetlifyProviderError } from "./provider-errors.js";

// parallel-type-allowed: the proto AnonymousSiteRecord is the design-time contract view and this package wires no buf codegen; the TypeScript form is richer on purpose — it holds the branded SecretRef custody locator, the literal schemaVersion and strategy refs, the compiled AnonymousClaimPlan, and a `0` sponsor exposure that is a type rather than a value the wire could widen.
export type AnonymousSiteRecord = {
	readonly schemaVersion: "hobo.provider-netlify.anonymous-site/v1";
	readonly definitionId: typeof NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID;
	readonly providerId: typeof NETLIFY_PROVIDER_ID;
	readonly claimStrategyRef: typeof NETLIFY_ANONYMOUS_CLAIM_STRATEGY_REF;
	readonly bootstrapStrategyRef: typeof NETLIFY_ANONYMOUS_BOOTSTRAP_STRATEGY_REF;
	readonly deploymentRef: string;
	readonly siteId: string;
	readonly siteName: string;
	readonly deployId: string;
	readonly siteUrl: string;
	readonly deployUrl?: string;
	/** Custody locator for the claim URL. Never the URL. */
	readonly claimUrlRef: SecretRef;
	/** One-time action id for the claim URL. Never the URL. */
	readonly claimActionId: string;
	readonly deployedAtMs: number;
	readonly claimDeadlineMs: number;
	readonly expirySource: ExpirySource;
	/** Anonymous: nobody is billed before the claim. */
	readonly sponsorExposureMinorUnits: 0;
	readonly cliPackageSpec: string;
	readonly anonymousAuthorityRevoked: boolean;
	readonly plan: AnonymousClaimPlan;
	readonly observedAtMs: number;
};

export type OwnershipSignal = {
	readonly id: string;
	readonly subjectRef: string;
	readonly independent: boolean;
	readonly passed: boolean;
	readonly detail: string;
};

export type SiteOwnershipVerification = {
	readonly itemId: string;
	readonly subjectRef: string;
	readonly transferred: boolean;
	readonly verified: boolean;
	readonly signals: readonly OwnershipSignal[];
	readonly reasons: readonly string[];
	readonly observedAtMs: number;
};

/**
 * Whether the pre-claim anonymous material can still change the site.
 *
 * Netlify documents no endpoint that revokes an anonymous deploy session, so
 * this is injected rather than assumed. A driver that skipped it would be
 * asserting a revocation it never performed.
 */
export interface AnonymousAuthorityProbe {
	canStillMutate(input: {
		readonly siteId: string;
		readonly claimUrlRef: SecretRef;
	}): Promise<{
		readonly usable: boolean;
		readonly detail: string;
		readonly observedAtMs: number;
	}>;
}

export type AnonymousSiteDriverOptions = {
	readonly runner: ProcessRunner;
	readonly custody: SecretCustodyPort;
	readonly oneTimeActions: OneTimeActionStore;
	readonly idempotency: IdempotencyStore;
	readonly clock: () => number;
	/** Only needed after a claim: the anonymous path itself has no client. */
	readonly client?: NetlifyClient;
	readonly authorityProbe?: AnonymousAuthorityProbe;
	readonly actionScope: {
		readonly tenantId: string;
		readonly projectId: string;
		readonly sessionId: string;
		readonly audience: string;
	};
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly timeoutMs?: number;
	readonly maxOutputBytes?: number;
	readonly producerEvidenceRef?: string;
};

export type DeployInput = {
	readonly deploymentRef: string;
	/** Working directory the CLI runs in. */
	readonly workDir: string;
	/** Prebuilt asset directory, relative to `workDir`. */
	readonly publishDir: string;
	readonly siteName?: string;
	readonly deployMessage?: string;
	readonly idempotencyKey: string;
	readonly fencingToken: string;
	readonly createdAtMs?: number;
};

export type AnonymousSiteDriver = {
	readonly providerId: typeof NETLIFY_PROVIDER_ID;
	readonly claimStrategyRef: typeof NETLIFY_ANONYMOUS_CLAIM_STRATEGY_REF;
	deploy(input: DeployInput): Promise<AnonymousSiteRecord>;
	observe(input: {
		readonly record: AnonymousSiteRecord;
		readonly tokenRef: SecretRef;
	}): Promise<AnonymousSiteRecord>;
	verifyOwnership(input: {
		readonly record: AnonymousSiteRecord;
		readonly expectedAccountId: string;
		readonly tokenRef: SecretRef;
	}): Promise<SiteOwnershipVerification>;
	revokeAnonymousAuthority(record: AnonymousSiteRecord): Promise<{
		readonly record: AnonymousSiteRecord;
		readonly evidenceRef: string;
	}>;
	assertClaimLive(record: AnonymousSiteRecord): void;
};

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;

export function createNetlifyAnonymousSiteDriver(
	options: AnonymousSiteDriverOptions,
): AnonymousSiteDriver {
	const producerEvidenceRef =
		options.producerEvidenceRef ??
		"hobo.evidence/provider-netlify/anonymous-static-site@2026-08-08";

	function requireClient(operation: string): NetlifyClient {
		if (options.client === undefined) {
			throw new NetlifyProviderError(
				"CLAIM_NOT_VERIFIED",
				`${operation} needs a Netlify API client; ownership cannot be confirmed from CLI output alone`,
			);
		}
		return options.client;
	}

	return {
		providerId: NETLIFY_PROVIDER_ID,
		claimStrategyRef: NETLIFY_ANONYMOUS_CLAIM_STRATEGY_REF,

		async deploy(input) {
			const attempt = await options.idempotency.begin(input.idempotencyKey);
			if (attempt.state === "replayed") {
				// Running the CLI again would create a second claimable site
				// that nothing is tracking, and the first one would sit there
				// unclaimed until Netlify reaped it.
				throw new NetlifyProviderError(
					"PROVIDER_OPERATION_AMBIGUOUS",
					`attempt ${input.idempotencyKey} already ran; observe or adopt the existing site instead of deploying again`,
					{
						detail: {
							...(attempt.siteId !== undefined
								? { siteId: attempt.siteId }
								: undefined),
							adoptable: attempt.siteId !== undefined,
						},
					},
				);
			}

			const createdAtMs = input.createdAtMs ?? options.clock();
			const startedAtMs = options.clock();
			const result = await runIsolatedNetlifyAnonymousDeploy({
				runner: options.runner,
				workDir: input.workDir,
				publishDir: input.publishDir,
				env: options.env ?? {},
				timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
				...(input.siteName === undefined
					? undefined
					: { siteName: input.siteName }),
				...(input.deployMessage === undefined
					? undefined
					: { deployMessage: input.deployMessage }),
			});
			const observation = parseAnonymousDeployOutput({
				result,
				observedAtMs: startedAtMs,
			});

			const plan = compileAnonymousClaimPlan({
				deploymentRef: input.deploymentRef,
				siteId: observation.siteId,
				deployedAtMs: observation.observedAtMs,
				createdAtMs,
				fencingToken: input.fencingToken,
				claimDeadlineMs: observation.claimDeadlineMs,
				expirySource: observation.expirySource,
			});

			// The claim URL leaves this scope only as a custody locator.
			// `depositSecret` re-parses what custody returns, so an
			// implementation that hands back the plaintext fails here.
			const claimRef = await depositSecret(
				options.custody,
				observation.claimUrlPlaintext,
				{
					providerId: NETLIFY_PROVIDER_ID,
					resourceRef: `netlify:site:${observation.siteId}`,
					purpose: "anonymous-claim-url",
					labels: { siteId: observation.siteId },
				},
			);
			const claimActionId = `${input.deploymentRef}#claim-url`;
			await options.oneTimeActions.put({
				id: claimActionId,
				value: observation.claimUrlPlaintext,
				tenantId: options.actionScope.tenantId,
				projectId: options.actionScope.projectId,
				sessionId: options.actionScope.sessionId,
				audience: options.actionScope.audience,
				expiresAt: plan.claimDeadlineMs,
				// The dashboard ceremony can legitimately be reopened after a
				// mis-click, so the URL is reusable inside its window; the
				// window is what bounds the exposure, and it is one hour.
				singleUse: false,
			});
			await options.idempotency.complete(
				input.idempotencyKey,
				observation.siteId,
			);

			return recordFrom({
				input,
				observation,
				plan,
				claimUrlRef: claimRef.ref,
				claimActionId,
			});
		},

		async observe({ record, tokenRef }) {
			const client = requireClient("observe");
			const access = await client.probeSiteAccess({
				siteId: record.siteId,
				tokenRef,
			});
			const observedAtMs = options.clock();
			if (access.kind === "absent") {
				throw new NetlifyProviderError(
					"CLAIM_EXPIRED",
					`netlify no longer has site ${record.siteId}; an unclaimed anonymous project is removed after its documented one hour window`,
					{
						detail: {
							siteId: record.siteId,
							claimDeadlineMs: record.claimDeadlineMs,
						},
					},
				);
			}
			return {
				...record,
				...(access.kind === "readable"
					? { siteName: access.site.name }
					: undefined),
				observedAtMs,
			};
		},

		async verifyOwnership({ record, expectedAccountId, tokenRef }) {
			const client = requireClient("verifyOwnership");
			const observedAtMs = options.clock();
			const subjectRef = `netlify:site:${record.siteId}`;
			const itemId = siteClaimItemId(record.deploymentRef);
			const signals: OwnershipSignal[] = [];
			const reasons: string[] = [];

			const access = await client.probeSiteAccess({
				siteId: record.siteId,
				tokenRef,
			});
			if (access.kind === "absent") {
				throw new NetlifyProviderError(
					"CLAIM_EXPIRED",
					`site ${record.siteId} is gone; there is nothing left to verify`,
					{ detail: { siteId: record.siteId } },
				);
			}

			// Signal 1: the claiming account can read the site, and the site
			// says that account owns it. Read access alone is not ownership.
			const readable = access.kind === "readable";
			const ownedByClaimer =
				readable && access.site.accountId === expectedAccountId;
			signals.push({
				id: "site-owned-by-claimer",
				subjectRef,
				independent: true,
				passed: ownedByClaimer,
				detail: ownedByClaimer
					? "the site resolves to the claiming account"
					: readable
						? "the site is readable but resolves to a different account"
						: "the claiming credential cannot read the site",
			});
			if (!ownedByClaimer) {
				reasons.push(
					readable
						? "the site did not move to the claiming account"
						: "the claiming credential cannot read the site, so ownership is unproven",
				);
			}

			// Signal 2: the pre-claim anonymous material must no longer work.
			// A site that the previous holder can still redeploy has not really
			// changed hands.
			if (options.authorityProbe === undefined) {
				signals.push({
					id: "anonymous-authority-unusable",
					subjectRef,
					independent: true,
					passed: false,
					detail: "no AnonymousAuthorityProbe is configured",
				});
				reasons.push(
					"whether the pre-claim anonymous claim material still works is unproven; configure an AnonymousAuthorityProbe or rotate it explicitly",
				);
			} else {
				const probe = await options.authorityProbe.canStillMutate({
					siteId: record.siteId,
					claimUrlRef: record.claimUrlRef,
				});
				signals.push({
					id: "anonymous-authority-unusable",
					subjectRef,
					independent: true,
					passed: !probe.usable,
					detail: probe.detail,
				});
				if (probe.usable) {
					reasons.push(
						"the pre-claim anonymous claim material can still mutate the site",
					);
				}
			}

			return {
				itemId,
				subjectRef,
				transferred: ownedByClaimer,
				verified: signals.every((signal) => signal.passed),
				signals,
				reasons,
				observedAtMs,
			};
		},

		async revokeAnonymousAuthority(record) {
			// The one thing that can actually be revoked here is HoBo's own copy
			// of the claim action; Netlify exposes no endpoint for the session
			// behind it. Dropping the one-time action closes the exposure this
			// package is responsible for, and the probe above is what proves the
			// provider side.
			await options.oneTimeActions.revoke(record.claimActionId);
			if (options.authorityProbe !== undefined) {
				const probe = await options.authorityProbe.canStillMutate({
					siteId: record.siteId,
					claimUrlRef: record.claimUrlRef,
				});
				if (probe.usable) {
					throw new NetlifyProviderError(
						"BOOTSTRAP_AUTHORITY_REMAINS",
						`the pre-claim anonymous material can still mutate site ${record.siteId} after revocation`,
						{ detail: { siteId: record.siteId } },
					);
				}
			}
			return {
				record: { ...record, anonymousAuthorityRevoked: true },
				evidenceRef: `${producerEvidenceRef}#revocation:${record.deploymentRef}`,
			};
		},

		assertClaimLive(record) {
			const nowMs = options.clock();
			if (record.claimDeadlineMs > nowMs) return;
			throw new NetlifyProviderError(
				"CLAIM_EXPIRED",
				`the anonymous claim window closed at ${new Date(record.claimDeadlineMs).toISOString()}; netlify removes unclaimed projects after one hour`,
				{
					detail: {
						siteId: record.siteId,
						claimDeadlineMs: record.claimDeadlineMs,
						expirySource: record.expirySource,
					},
				},
			);
		},
	};
}

function recordFrom(args: {
	readonly input: DeployInput;
	readonly observation: AnonymousDeployObservation;
	readonly plan: AnonymousClaimPlan;
	readonly claimUrlRef: SecretRef;
	readonly claimActionId: string;
}): AnonymousSiteRecord {
	const { input, observation, plan, claimUrlRef, claimActionId } = args;
	return {
		schemaVersion: "hobo.provider-netlify.anonymous-site/v1",
		definitionId: NETLIFY_ANONYMOUS_STATIC_SITE_DEFINITION_ID,
		providerId: NETLIFY_PROVIDER_ID,
		claimStrategyRef: NETLIFY_ANONYMOUS_CLAIM_STRATEGY_REF,
		bootstrapStrategyRef: NETLIFY_ANONYMOUS_BOOTSTRAP_STRATEGY_REF,
		deploymentRef: input.deploymentRef,
		siteId: observation.siteId,
		siteName: observation.siteName,
		deployId: observation.deployId,
		siteUrl: observation.siteUrl,
		...(observation.deployUrl !== undefined
			? { deployUrl: observation.deployUrl }
			: undefined),
		claimUrlRef,
		claimActionId,
		deployedAtMs: observation.observedAtMs,
		claimDeadlineMs: plan.claimDeadlineMs,
		expirySource: plan.expirySource,
		sponsorExposureMinorUnits: 0,
		cliPackageSpec: NETLIFY_CLI_PACKAGE_SPEC,
		anonymousAuthorityRevoked: false,
		plan,
		observedAtMs: observation.observedAtMs,
	};
}

/**
 * Translate a verification into commands for the shared `@hobo/claims` reducer.
 *
 * The driver never mutates claim state itself; this is the whole interface
 * between provider knowledge and the shared state machine.
 */
export function anonymousSiteClaimCommands(input: {
	readonly record: AnonymousSiteRecord;
	readonly verification: SiteOwnershipVerification;
	readonly at: Instant;
}): readonly ClaimCommand[] {
	const { record, verification, at } = input;
	const expired = record.claimDeadlineMs <= at;
	return [
		{ kind: "BeginClaimItem", itemId: verification.itemId, at },
		{
			kind: "ObserveClaimItem",
			itemId: verification.itemId,
			observedStatus: verification.transferred
				? "claimed"
				: expired
					? "expired"
					: "pending",
			at,
		},
		...(verification.transferred
			? ([
					{
						kind: "VerifyOwnership",
						itemId: verification.itemId,
						verified: verification.verified,
						evidenceRef: `hobo.evidence/netlify/${verification.itemId}`,
						creatorAuthorityAfterClaim: verification.verified
							? "absent"
							: "retained",
					},
				] as const)
			: []),
	];
}

/**
 * Refuse to call a half-finished claim finished.
 *
 * `@hobo/claims` already derives the bundle status; this maps it onto the
 * provider error vocabulary so a caller gets a code rather than a boolean.
 */
export function assertClaimSettled(state: ClaimCoordinatorState): void {
	const bundle = state.bundle;
	if (bundle === undefined) {
		throw new NetlifyProviderError(
			"CLAIM_REPAIR_REQUIRED",
			"no claim bundle is attached to this anonymous deployment",
		);
	}
	if (bundle.status === "complete") return;
	if (bundle.status === "partially-claimed") {
		throw new NetlifyProviderError(
			"CLAIM_PARTIALLY_COMPLETED",
			`claim bundle ${bundle.id} moved some subjects and not others; it is repairable, not complete`,
			{ detail: { bundleId: bundle.id, bundleStatus: bundle.status } },
		);
	}
	if (bundle.status === "claimed-needs-remediation") {
		throw new NetlifyProviderError(
			"CLAIM_REPAIR_REQUIRED",
			`claim bundle ${bundle.id} needs remediation before it can complete`,
			{ detail: { bundleId: bundle.id, bundleStatus: bundle.status } },
		);
	}
	if (bundle.status === "expired") {
		throw new NetlifyProviderError(
			"CLAIM_EXPIRED",
			`claim bundle ${bundle.id} expired before it was claimed`,
			{ detail: { bundleId: bundle.id } },
		);
	}
	throw new NetlifyProviderError(
		"CLAIM_NOT_VERIFIED",
		`claim bundle ${bundle.id} is ${bundle.status}`,
		{ detail: { bundleId: bundle.id, bundleStatus: bundle.status } },
	);
}

export function isClaimError(value: Error): value is ClaimError {
	return value instanceof ClaimError;
}
