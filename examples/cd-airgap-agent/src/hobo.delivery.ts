// Delivery into an air-gapped Yard (plan 0024 D5, D19, I3, I24; §10 WP20).
//
// The plant network has no route to the internet. Artifacts are mirrored by
// digest into the Yard's registry (D22: mirrors keep digests), CD polls that
// registry, and an agent inside the plant pulls desired state from the
// in-Yard Station feed over outbound HTTPS. The Station never dials the agent
// and never holds a plant credential (I3).
import { create } from "@bufbuild/protobuf";
import {
	ArtifactKind,
	AutoPromotion,
	Availability,
	CampSetRecordSchema,
	CD_DEFAULTS,
	FreightSourceRecordSchema,
	FreightSubject,
	PIPELINE_SCHEMA,
	PipelineNodeRecordSchema,
	PipelineRecordSchema,
	RailDeliveryRecordSchema,
	RailEnrollmentRecordSchema,
	RolloutStrategy,
	SelectionStrategy,
	SelectorRecordSchema,
	SOURCE_SCHEMA,
	SubscriptionKind,
	SubscriptionRecordSchema,
	VerificationSpecRecordSchema,
} from "@hobo/cd";

/** Every host CD or the agent may reach. Nothing else is routable. */
export const YARD_HOSTS = Object.freeze(["registry.plant.internal", "station.plant.internal"] as const);

export const STATION_FEED = "https://station.plant.internal/v1/cd/";
export const BINDLE = "factory/plc-gateway";

export const source = create(FreightSourceRecordSchema, {
	schemaVersion: SOURCE_SCHEMA,
	name: "plc-gateway-local",
	bindle: BINDLE,
	automatic: true,
	pollIntervalMs: BigInt(CD_DEFAULTS.sourcePollIntervalMs),
	subscriptions: [
		create(SubscriptionRecordSchema, {
			name: "gateway",
			kind: SubscriptionKind.OCI_REPOSITORY,
			locator: "registry.plant.internal/factory/plc-gateway",
			ecosystem: "oci",
			selection: SelectionStrategy.SEMVER,
			semverRange: ">=3.0.0 <4.0.0",
			discoveryLimit: CD_DEFAULTS.sourceDiscoveryLimit,
			credentialRef: "file:///etc/hobo/plant-registry-read",
			requireProvenance: true,
			trustedBuilderIds: ["https://build.plant.internal/builders/hermetic@v2"],
			trustedSignerIdentities: ["release-signer@plant.internal"],
			artifactName: "gateway",
			artifactKind: ArtifactKind.OCI_IMAGE,
		}),
	],
});

export const plantCamps = create(CampSetRecordSchema, {
	name: "plant-floor",
	selector: create(SelectorRecordSchema, { labels: { site: "plant-7", zone: "ot" } }),
});

/** The Station's Rail `delivery` object: two separate approvers, no auto-accept (R14, I24). */
export const railDelivery = create(RailDeliveryRecordSchema, {
	campSets: ["plant-floor"],
	enrollment: create(RailEnrollmentRecordSchema, { separateApprovers: true, autoAcceptScopes: [] }),
	maxFanoutCamps: 50,
});

export const pipeline = create(PipelineRecordSchema, {
	schemaVersion: PIPELINE_SCHEMA,
	name: "plc-gateway",
	bindle: BINDLE,
	subject: FreightSubject.BINDLE,
	nodes: [
		create(PipelineNodeRecordSchema, {
			name: "bench",
			campIds: ["plant-7-bench"],
			fromSources: ["plc-gateway-local"],
			availability: Availability.ONE_OF,
			autoPromotion: AutoPromotion.NEWEST,
			strategy: RolloutStrategy.ALL_AT_ONCE,
			verification: create(VerificationSpecRecordSchema, {
				windowMs: BigInt(CD_DEFAULTS.verificationWindowMs),
				requiredObservations: CD_DEFAULTS.verificationRequiredObservations,
				progressDeadlineMs: BigInt(CD_DEFAULTS.verificationProgressDeadlineMs),
				failOnNoData: true,
			}),
		}),
		create(PipelineNodeRecordSchema, {
			name: "line",
			campIds: ["plant-7-line-a", "plant-7-line-b"],
			fromNodes: ["bench"],
			availability: Availability.ONE_OF,
			requiredSoakMs: 86_400_000n,
			autoPromotion: AutoPromotion.DISABLED,
			approvalRequired: true,
			strategy: RolloutStrategy.ALL_AT_ONCE,
		}),
	],
});

export const delivery = { sources: [source], publishers: [], windows: [], pipelines: [pipeline] };
