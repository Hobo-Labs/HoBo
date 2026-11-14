// Delivery as code for a Bindle built on GitLab CI (plan 0024 D3, D4, D10).
// Apply with `hobo deploy pipeline apply --file src/hobo.delivery.ts`.
//
// CD reads the Git repository over smart-HTTP protocol v2 (no Git binary, no
// host API) and the GitLab container registry over the OCI distribution API.
// It assembles Freight from both at the same commit. GitLab pushes are
// authenticated with a GitLab OIDC id_token matched against a trusted publisher.
import { create } from "@bufbuild/protobuf";
import {
	ArtifactKind,
	AssemblyRule,
	AutoPromotion,
	Availability,
	CD_DEFAULTS,
	CD_RAMP_DEFAULTS,
	ChangeWindowRecordSchema,
	FreightSourceRecordSchema,
	FreightSubject,
	PIPELINE_SCHEMA,
	PipelineNodeRecordSchema,
	PipelineRecordSchema,
	RolloutStrategy,
	SelectionStrategy,
	SelectorRecordSchema,
	SOURCE_SCHEMA,
	SubscriptionKind,
	SubscriptionRecordSchema,
	TrustedPublisherRecordSchema,
	VerificationSpecRecordSchema,
	WindowKind,
} from "@hobo/cd";

export const BINDLE = "platform/billing";
export const GITLAB_ISSUER = "https://gitlab.com";
export const PROJECT = "acme/platform/billing";

export const publisher = create(TrustedPublisherRecordSchema, {
	name: "gitlab-billing-release",
	issuer: GITLAB_ISSUER,
	audience: "hobo.cd",
	requiredClaims: { project_path: PROJECT, ref: "main", ref_protected: "true", ref_type: "branch" },
	bindles: [BINDLE],
});

const SIGNER = `https://gitlab.com/${PROJECT}//.gitlab-ci.yml@refs/heads/main`;
const BUILDER = "https://gitlab.com/acme/platform/billing/-/runners/hosted";

export const source = create(FreightSourceRecordSchema, {
	schemaVersion: SOURCE_SCHEMA,
	name: "billing",
	bindle: BINDLE,
	assembly: AssemblyRule.SAME_COMMIT,
	automatic: true,
	pollIntervalMs: BigInt(CD_DEFAULTS.sourcePollIntervalMs),
	subscriptions: [
		create(SubscriptionRecordSchema, {
			name: "config",
			kind: SubscriptionKind.GIT_REPOSITORY,
			locator: `https://gitlab.com/${PROJECT}.git`,
			ecosystem: "git",
			selection: SelectionStrategy.NEWEST_COMMIT,
			branch: "main",
			includePaths: ["deploy/**", "hobo.bindle.ts"],
			discoveryLimit: CD_DEFAULTS.sourceDiscoveryLimit,
			credentialRef: "vault://ci/gitlab-read",
			artifactName: "config",
			artifactKind: ArtifactKind.SOURCE_TREE,
		}),
		create(SubscriptionRecordSchema, {
			name: "api",
			kind: SubscriptionKind.OCI_REPOSITORY,
			locator: `registry.gitlab.com/${PROJECT}/api`,
			ecosystem: "oci",
			selection: SelectionStrategy.NEWEST_BUILD,
			allowPattern: "^main-[0-9a-f]{12}$",
			discoveryLimit: CD_DEFAULTS.sourceDiscoveryLimit,
			credentialRef: "vault://ci/gitlab-registry-read",
			requireProvenance: true,
			trustedBuilderIds: [BUILDER],
			trustedSignerIdentities: [SIGNER],
			artifactName: "api",
			artifactKind: ArtifactKind.OCI_IMAGE,
		}),
	],
});

/** Quarter-end freeze for the finance Camps; rollback stays allowed (D10). */
export const quarterEnd = create(ChangeWindowRecordSchema, {
	name: "quarter-end",
	kind: WindowKind.FREEZE,
	selector: create(SelectorRecordSchema, { labels: { domain: "finance" } }),
	rrule: "FREQ=YEARLY;BYMONTH=3,6,9,12;BYMONTHDAY=-3",
	durationMs: 72n * 3_600_000n,
	timezone: "Europe/Berlin",
	startsAt: "2026-03-29T00:00:00+02:00",
	rollbackAllowed: true,
});

export const verification = create(VerificationSpecRecordSchema, {
	windowMs: BigInt(CD_DEFAULTS.verificationWindowMs),
	requiredObservations: CD_DEFAULTS.verificationRequiredObservations,
	progressDeadlineMs: BigInt(CD_DEFAULTS.verificationProgressDeadlineMs),
	failOnNoData: true,
});

export const pipeline = create(PipelineRecordSchema, {
	schemaVersion: PIPELINE_SCHEMA,
	name: "billing",
	bindle: BINDLE,
	subject: FreightSubject.BINDLE,
	nodes: [
		create(PipelineNodeRecordSchema, {
			name: "review",
			campIds: ["billing-review"],
			fromSources: ["billing"],
			availability: Availability.ONE_OF,
			autoPromotion: AutoPromotion.NEWEST,
			strategy: RolloutStrategy.ALL_AT_ONCE,
			previewTtlMs: 86_400_000n,
		}),
		create(PipelineNodeRecordSchema, {
			name: "staging",
			campIds: ["billing-staging"],
			fromSources: ["billing"],
			availability: Availability.ONE_OF,
			autoPromotion: AutoPromotion.NEWEST,
			strategy: RolloutStrategy.ALL_AT_ONCE,
			verification,
		}),
		create(PipelineNodeRecordSchema, {
			name: "prod",
			campIds: ["billing-prod"],
			fromNodes: ["staging"],
			availability: Availability.ONE_OF,
			requiredSoakMs: 7_200_000n,
			autoPromotion: AutoPromotion.DISABLED,
			strategy: RolloutStrategy.BLUE_GREEN,
			stagePercents: [...CD_RAMP_DEFAULTS.blueGreen],
			verification,
			windows: ["quarter-end"],
		}),
	],
});

export const delivery = { sources: [source], publishers: [publisher], windows: [quarterEnd], pipelines: [pipeline] };
