// Default bindings of the frozen factories and the in-package adapters
// (WP18, plan 0024). Every import below names a sibling work package's module;
// they compile once the swarm merges into integration/hobo-cd.
// binds at merge (plan 0024)
import type { DurableEventStore } from "@hobo/core";
import { ReconcilerMode } from "../_generated/cd_pb.js";
import { createAgentEnrollment, createHttpTransport } from "../agent/index.js"; // binds at merge (plan 0024)
import {
	createArtifactStore,
	createArtifactVerifier,
} from "../artifacts/index.js"; // binds at merge (plan 0024)
import { createCdAuthorizer } from "../authz/index.js"; // binds at merge (plan 0024)
import { createFailoverController } from "../failover/index.js"; // binds at merge (plan 0024)
import { createFanoutController } from "../fanout/index.js"; // binds at merge (plan 0024)
import { createDeliveryFeedHandler } from "../feed/index.js"; // binds at merge (plan 0024)
import { createFreightLedger } from "../freight/index.js"; // binds at merge (plan 0024)
import {
	createFreightIngest,
	createTrustedPublisherVerifier,
} from "../ingest/index.js"; // binds at merge (plan 0024)
import { createCampInventory } from "../inventory/index.js"; // binds at merge (plan 0024)
import { createPipelineController } from "../pipelines/index.js"; // binds at merge (plan 0024)
import { createPlacementEngine } from "../placement/index.js"; // binds at merge (plan 0024)
import type { CdFactories, Digest, Realizer } from "../ports.js";
import {
	createCampPolicy,
	createPostureService,
	createShadowRecorder,
} from "../posture/index.js"; // binds at merge (plan 0024)
import {
	createA2HApprover,
	createDeployGate,
	createPlanningResolver,
	createPromotionService,
	type DeployGateDeps,
	type PlanningDeps,
} from "../promotion/index.js"; // binds at merge (plan 0024)
import { createProvenanceVerifier } from "../provenance/index.js"; // binds at merge (plan 0024)
import {
	createCampReconciler,
	createDriftPolicy,
	createInProcessTransport,
	type DriftPolicyOptions,
} from "../reconcile/index.js"; // binds at merge (plan 0024)
import {
	type CutoverTrafficShifterDeps,
	createCutoverTrafficShifter,
	createHarnessRolloutEngine,
	createRolloutOrchestrator,
	type HarnessRolloutEngineDeps,
} from "../rollout/index.js"; // binds at merge (plan 0024)
import { createCdService } from "../service/index.js"; // binds at merge (plan 0024)
import { createDesiredState } from "../sets/index.js"; // binds at merge (plan 0024)
import {
	createFreightSources,
	createSubscriptionDrivers,
} from "../sources/index.js"; // binds at merge (plan 0024)
import { createCdTelemetry, createTelemetrySink } from "../telemetry/index.js"; // binds at merge (plan 0024)
import {
	createHealthSources,
	createVerificationEngine,
} from "../verification/index.js"; // binds at merge (plan 0024)
import { createChangeWindows } from "../windows/index.js"; // binds at merge (plan 0024)
import type { RailCatalog } from "./rails.js";
import type { CdComposeAdapters, CdComposeScope } from "./wire.js";

/** Every frozen factory bound to its module (binds at merge, plan 0024). */
export const defaultCdFactories: CdFactories = Object.freeze({
	createFreightLedger,
	createTrustedPublisherVerifier,
	createFreightIngest,
	createFreightSources,
	createSubscriptionDrivers,
	createArtifactStore,
	createArtifactVerifier,
	createProvenanceVerifier,
	createDesiredState,
	createPipelineController,
	createChangeWindows,
	createPromotionService,
	createCampReconciler,
	createInProcessTransport,
	createVerificationEngine,
	createHealthSources,
	createRolloutOrchestrator,
	createAgentEnrollment,
	createHttpTransport,
	createDeliveryFeedHandler,
	createCdService,
	createCdAuthorizer,
	createCdTelemetry,
	createTelemetrySink,
	createCampInventory,
	createPlacementEngine,
	createFanoutController,
	createFailoverController,
	createCampPolicy,
	createShadowRecorder,
	createPostureService,
}); // binds at merge (plan 0024)

type ScopeOwned =
	| "store"
	| "tenant"
	| "now"
	| "topology"
	| "windows"
	| "campPolicy"
	| "shadow"
	| "posture"
	| "resolvePack"
	| "telemetry"
	| "stationRail";

/** Host inputs the in-package adapters need beyond the composed modules. */
export type CdHostInputs = Readonly<{
	/** Matching/Planner inputs (WP6 planning adapter): registry, declarations, per-Camp planning. */
	planning: Omit<PlanningDeps, "store" | "tenant" | "now" | "desired">;
	/** Gate inputs the host owns: contracts, subject classification, trust, cost. */
	gate: Omit<DeployGateDeps, ScopeOwned>;
	/** Station cutover routing per Camp; absent → no traffic capability (fail closed). */
	routing?: CutoverTrafficShifterDeps["routing"];
	flags?: HarnessRolloutEngineDeps["flags"];
	drift?: DriftPolicyOptions;
	/** Realizer per mode; a missing mode refuses that reconciler. */
	realizers: Readonly<
		Partial<
			Record<
				"conductor" | "agent" | "publisher",
				(scope: CdComposeScope) => Realizer
			>
		>
	>;
	resolvePack: CdComposeAdapters["resolvePack"];
	packs: CdComposeAdapters["packs"];
	railCatalog: RailCatalog;
	store: DurableEventStore;
}>;

const MODE_KEY: ReadonlyMap<
	ReconcilerMode,
	"conductor" | "agent" | "publisher"
> = new Map([
	[ReconcilerMode.CONDUCTOR, "conductor"],
	[ReconcilerMode.AGENT, "agent"],
	[ReconcilerMode.PUBLISHER, "publisher"],
]);

/** The WP6/WP7/WP10 adapters bound to host inputs (binds at merge, plan 0024). */
export function defaultCdAdapters(host: CdHostInputs): CdComposeAdapters {
	return Object.freeze({
		resolver: (s) =>
			createPlanningResolver({
				...s.base,
				desired: s.desired,
				...host.planning,
			}),
		gate: (s) =>
			createDeployGate({
				...s.base,
				...host.gate,
				topology: s.topology,
				windows: s.windows,
				campPolicy: s.campPolicy,
				shadow: s.shadow,
				posture: s.posture,
				resolvePack: host.resolvePack,
				telemetry: s.telemetry,
				async stationRail(stationId: string) {
					const rail = await host.railCatalog.active(stationId);
					if (!rail) return undefined;
					const railDigest: Digest = rail.railDigest;
					return { railDigest, policyPack: await host.resolvePack(railDigest) };
				},
			}),
		approvals: (s) =>
			createA2HApprover({
				store: s.base.store,
				tenant: s.base.tenant,
				now: s.base.now,
				notify: s.notify,
				authorizer: s.authorizer,
				telemetry: s.telemetry,
			}),
		rolloutEngine: (s) =>
			createHarnessRolloutEngine({
				...s.base,
				...(host.flags !== undefined ? { flags: host.flags } : undefined),
			}),
		...(host.routing !== undefined
			? {
					traffic: (s: CdComposeScope) =>
						createCutoverTrafficShifter({
							routing: host.routing as NonNullable<CdHostInputs["routing"]>,
							now: s.base.now,
						}),
				}
			: undefined),
		drift: () => createDriftPolicy(host.drift ?? {}),
		realizer: (mode, s) => {
			const key = MODE_KEY.get(mode);
			const build = key ? host.realizers[key] : undefined;
			return build?.(s);
		},
		resolvePack: host.resolvePack,
		packs: host.packs,
	});
}
