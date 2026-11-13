// Delivery as code for a Bindle built on GitHub Actions (plan 0024 D3, D4).
// Apply with `hobo deploy pipeline apply --file src/hobo.delivery.ts`.
//
// The workflow never holds a HoBo credential. It proves who it is with a
// GitHub OIDC token, which CD checks against this TrustedPublisherRecord, and
// ships a Sigstore-signed SLSA provenance bundle. CD also polls GHCR itself,
// so the push only nudges. A verified read is always the source of truth.
import { create } from "@bufbuild/protobuf";
import {
	ArtifactKind,
	AssemblyRule,
	AutoPromotion,
	Availability,
	CD_DEFAULTS,
	CD_RAMP_DEFAULTS,
	ChangeWindowRecordSchema,
	Cohort,
	ComparisonCheckRecordSchema,
	Direction,
	FreightSourceRecordSchema,
	FreightSubject,
	HealthQueryRecordSchema,
	HealthSourceKind,
	PIPELINE_SCHEMA,
	PipelineNodeRecordSchema,
	PipelineRecordSchema,
	RolloutStrategy,
	SelectionStrategy,
	Sensitivity,
	SOURCE_SCHEMA,
	SubscriptionKind,
	SubscriptionRecordSchema,
	TrustedPublisherRecordSchema,
	VerificationSpecRecordSchema,
	WindowKind,
} from "@hobo/cd";

export const BINDLE = "acme/shop";
export const REPOSITORY = "acme/shop";
export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
export const SLSA_BUILDER = "https://github.com/slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@refs/tags/v2.1.0";
export const RELEASE_WORKFLOW = `https://github.com/${REPOSITORY}/.github/workflows/release.yml@refs/heads/main`;

/** GitHub OIDC trusted publisher: exact-match claims, no wildcards. */
export const publisher = create(TrustedPublisherRecordSchema, {
	name: "github-acme-shop-release",
	issuer: GITHUB_ISSUER,
	audience: "hobo.cd",
	requiredClaims: {
		repository: REPOSITORY,
		workflow_ref: `${REPOSITORY}/.github/workflows/release.yml@refs/heads/main`,
		environment: "release",
	},
	bindles: [BINDLE],
});

/** GHCR polling, provenance required and pinned to the SLSA generator and the release workflow. */
export const source = create(FreightSourceRecordSchema, {
	schemaVersion: SOURCE_SCHEMA,
	name: "shop-ghcr",
	bindle: BINDLE,
	assembly: AssemblyRule.SAME_COMMIT,
	automatic: true,
	pollIntervalMs: BigInt(CD_DEFAULTS.sourcePollIntervalMs),
	subscriptions: [
		create(SubscriptionRecordSchema, {
			name: "app",
			kind: SubscriptionKind.OCI_REPOSITORY,
			locator: "ghcr.io/acme/shop",
			ecosystem: "oci",
			selection: SelectionStrategy.SEMVER,
			semverRange: ">=1.0.0",
			discoveryLimit: CD_DEFAULTS.sourceDiscoveryLimit,
			credentialRef: "secret://ci/ghcr-read",
			requireProvenance: true,
			trustedBuilderIds: [SLSA_BUILDER],
			trustedSignerIdentities: [RELEASE_WORKFLOW],
			artifactName: "app",
			artifactKind: ArtifactKind.OCI_IMAGE,
		}),
	],
});

export const weekendFreeze = create(ChangeWindowRecordSchema, {
	name: "weekend-freeze",
	kind: WindowKind.FREEZE,
	rrule: "FREQ=WEEKLY;BYDAY=SA",
	durationMs: 48n * 3_600_000n,
	timezone: "America/Chicago",
	startsAt: "2026-01-03T00:00:00-06:00",
	rollbackAllowed: true,
});

const errorRate = create(HealthQueryRecordSchema, {
	name: "http_error_ratio",
	source: HealthSourceKind.PROMETHEUS,
	endpointRef: "prometheus://observability/prod",
	query: 'sum(rate(http_requests_total{app="shop",code=~"5.."}[1m])) / sum(rate(http_requests_total{app="shop"}[1m]))',
	unit: "ratio",
	cohortLabel: "track",
});

/** D9: canary vs baseline, Mann–Whitney at MEDIUM sensitivity; no data fails. */
export const canaryVerification = create(VerificationSpecRecordSchema, {
	windowMs: BigInt(CD_DEFAULTS.verificationWindowMs),
	requiredObservations: CD_DEFAULTS.verificationRequiredObservations,
	progressDeadlineMs: BigInt(CD_DEFAULTS.verificationProgressDeadlineMs),
	failOnNoData: true,
	comparisons: [create(ComparisonCheckRecordSchema, { query: errorRate, direction: Direction.HIGHER_IS_WORSE, sensitivity: Sensitivity.MEDIUM, minSamples: 3 })],
});

export const pipeline = create(PipelineRecordSchema, {
	schemaVersion: PIPELINE_SCHEMA,
	name: "shop",
	bindle: BINDLE,
	subject: FreightSubject.BINDLE,
	nodes: [
		create(PipelineNodeRecordSchema, {
			name: "dev",
			campIds: ["shop-dev"],
			fromSources: ["shop-ghcr"],
			availability: Availability.ONE_OF,
			autoPromotion: AutoPromotion.NEWEST,
			strategy: RolloutStrategy.ALL_AT_ONCE,
		}),
		create(PipelineNodeRecordSchema, {
			name: "staging",
			campIds: ["shop-staging"],
			fromNodes: ["dev"],
			availability: Availability.ONE_OF,
			autoPromotion: AutoPromotion.MATCH_UPSTREAM,
			strategy: RolloutStrategy.CANARY,
			stagePercents: [...CD_RAMP_DEFAULTS.canary],
			verification: canaryVerification,
		}),
		create(PipelineNodeRecordSchema, {
			name: "prod",
			campIds: ["shop-prod-us", "shop-prod-eu"],
			fromNodes: ["staging"],
			availability: Availability.ONE_OF,
			requiredSoakMs: 3_600_000n,
			autoPromotion: AutoPromotion.DISABLED,
			approvalRequired: true,
			strategy: RolloutStrategy.CANARY,
			stagePercents: [...CD_RAMP_DEFAULTS.canary],
			verification: canaryVerification,
			windows: ["weekend-freeze"],
		}),
	],
});

/** The module `hobo deploy pipeline apply --file` reads. */
export const delivery = { sources: [source], publishers: [publisher], windows: [weekendFreeze], pipelines: [pipeline] };

// Cohort used by the canary query's label; exported so the dashboards match.
export const CANARY_COHORT = Cohort.CANARY;
