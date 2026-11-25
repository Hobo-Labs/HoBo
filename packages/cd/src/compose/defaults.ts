import type { DurableEventStore } from "@hobo/core";
import { ReconcilerMode } from "../_generated/cd_pb.js";
import { createAgentEnrollment, createHttpTransport } from "../agent/index.js";
import {
	createArtifactStore,
	createArtifactVerifier,
} from "../artifacts/index.js";
import { createCdAuthorizer } from "../authz/index.js";
import { createFailoverController } from "../failover/index.js";
import { createFanoutController } from "../fanout/index.js";
import { createDeliveryFeedHandler } from "../feed/index.js";
import { createFreightLedger } from "../freight/index.js";
import {
	createFreightIngest,
	createTrustedPublisherVerifier,
} from "../ingest/index.js";
import { createCampInventory } from "../inventory/index.js";
import { createPipelineController } from "../pipelines/index.js";
import { createPlacementEngine } from "../placement/index.js";
import type { CdFactories, Digest, Realizer } from "../ports.js";
import {
	createCampPolicy,
	createPostureService,
	createShadowRecorder,
} from "../posture/index.js";
import {
	createA2HApprover,
	createDeployGate,
	createPlanningResolver,
	createPromotionService,
	type DeployGateDeps,
	type PlanningDeps,
} from "../promotion/index.js";
import { createProvenanceVerifier } from "../provenance/index.js";
import {
	createCampReconciler,
	createDriftPolicy,
	createInProcessTransport,
	type DriftPolicyOptions,
} from "../reconcile/index.js";
import {
	type CutoverTrafficShifterDeps,
	createCutoverTrafficShifter,
	createHarnessRolloutEngine,
	createRolloutOrchestrator,
	type HarnessRolloutEngineDeps,
} from "../rollout/index.js";
import { createCdService } from "../service/index.js";
import { createDesiredState } from "../sets/index.js";
import {
	createFreightSources,
	createSubscriptionDrivers,
} from "../sources/index.js";
import { createCdTelemetry, createTelemetrySink } from "../telemetry/index.js";
import {
	createHealthSources,
	createVerificationEngine,
} from "../verification/index.js";
import { createChangeWindows } from "../windows/index.js";
import type { RailCatalog } from "./rails.js";
import type { CdComposeAdapters, CdComposeScope } from "./wire.js";

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
});

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

export type CdHostInputs = Readonly<{
	planning: Omit<PlanningDeps, "store" | "tenant" | "now" | "desired">;
	gate: Omit<DeployGateDeps, ScopeOwned>;
	routing?: CutoverTrafficShifterDeps["routing"];
	flags?: HarnessRolloutEngineDeps["flags"];
	drift?: DriftPolicyOptions;
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

export function defaultCdAdapters(host: CdHostInputs): CdComposeAdapters {
	const routing = host.routing;
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
		...(routing !== undefined
			? {
					traffic: (s: CdComposeScope) =>
						createCutoverTrafficShifter({ routing, now: s.base.now }),
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
