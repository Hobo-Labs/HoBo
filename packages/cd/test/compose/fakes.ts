/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-chained-type-assertions, anti-slop/no-runtime-typeof, anti-slop/no-known-value-widening, anti-slop/no-unsafe-dictionary-type -- SAFETY: test doubles stand in for whole frozen ports; each is a recording proxy cast once to the port it replaces. */
// Test doubles for the composition root (WP18). Every fake factory records the
// deps it received and returns a recording module: any method call resolves
// to "<module>.<method>" and is logged, so wiring is observable end to end.
import type {
	DurableEventStore,
	EventEnvelope,
	EventPosition,
	PositionedEvent,
	PrincipalRef,
	ReadAllOptions,
} from "@hobo/core";
import type { RailCatalog, RailCatalogEntry } from "../../src/compose/rails.js";
import type { CdComposeAdapters } from "../../src/compose/wire.js";
import type {
	CampId,
	CampTopology,
	CdBase,
	CdFactories,
	OtelMetricPoint,
	OtelSpan,
	TelemetrySink,
	TopologyReader,
} from "../../src/ports.js";

export const principal = {
	kind: "service",
	id: "compose-test",
} as PrincipalRef;
export const asCamp = (id: string) => id as CampId;

export type FakeStore = DurableEventStore & {
	push(streamId: string, type: string, data: unknown): EventPosition;
	readonly events: PositionedEvent[];
};

export function fakeStore(): FakeStore {
	const events: PositionedEvent[] = [];
	let next = 1n;
	const store = {
		events,
		push(streamId: string, type: string, data: unknown) {
			const position = next as EventPosition;
			next += 1n;
			const event: EventEnvelope = {
				id: `evt-${position}`,
				type,
				v: 1,
				streamId,
				seq: events.filter((e) => e.event.streamId === streamId).length + 1,
				ts: new Date(Number(position) * 1000).toISOString(),
				actor: principal,
				tenant: "t1",
				data,
			};
			events.push({ position, event });
			return position;
		},
		async *readAll(options?: ReadAllOptions): AsyncIterable<PositionedEvent> {
			for (const e of events.slice()) {
				if (options?.after !== undefined && e.position <= options.after)
					continue;
				yield e;
			}
		},
		async *read(streamId: string): AsyncIterable<EventEnvelope> {
			for (const e of events) if (e.event.streamId === streamId) yield e.event;
		},
	};
	return store as unknown as FakeStore;
}

export type RecordingSink = TelemetrySink & {
	readonly points: OtelMetricPoint[];
};

export function recordingSink(): RecordingSink {
	const points: OtelMetricPoint[] = [];
	const spans: OtelSpan[] = [];
	return {
		points,
		async metrics(p) {
			points.push(...p);
		},
		async spans(s) {
			spans.push(...s);
		},
	};
}

export function base(store: DurableEventStore = fakeStore()): CdBase {
	return { store, tenant: "t1", now: () => 1_700_000_000_000 };
}

export type CallLog = string[];

/** A module whose every member is a recording async method. */
export function recordingModule<T extends object>(
	name: string,
	log: CallLog,
): T {
	return new Proxy(
		{ __module: name },
		{
			get(target, property) {
				if (property === "then") return undefined;
				if (property === "__module") return target.__module;
				if (typeof property !== "string") return undefined;
				return async (..._args: unknown[]) => {
					log.push(`${name}.${property}`);
					return `${name}.${property}`;
				};
			},
		},
	) as unknown as T;
}

export const MODULE_OF: Readonly<Record<keyof CdFactories, string>> = {
	createFreightLedger: "freight",
	createTrustedPublisherVerifier: "publishers",
	createFreightIngest: "ingest",
	createFreightSources: "sources",
	createSubscriptionDrivers: "drivers",
	createArtifactStore: "artifacts",
	createArtifactVerifier: "artifactVerifier",
	createProvenanceVerifier: "provenance",
	createDesiredState: "desired",
	createPipelineController: "pipelines",
	createChangeWindows: "windows",
	createPromotionService: "promotions",
	createCampReconciler: "reconciler",
	createInProcessTransport: "inProcessTransport",
	createVerificationEngine: "verification",
	createHealthSources: "healthSources",
	createRolloutOrchestrator: "rollouts",
	createAgentEnrollment: "enrollment",
	createHttpTransport: "httpTransport",
	createDeliveryFeedHandler: "feed",
	createCdService: "service",
	createCdAuthorizer: "authorizer",
	createCdTelemetry: "telemetry",
	createTelemetrySink: "sink",
	createCampInventory: "inventory",
	createPlacementEngine: "placement",
	createFanoutController: "fanout",
	createFailoverController: "failover",
	createCampPolicy: "campPolicy",
	createShadowRecorder: "shadow",
	createPostureService: "posture",
};

export type FactoryCall = Readonly<{
	factory: keyof CdFactories;
	args: readonly unknown[];
}>;

export function fakeFactories(log: CallLog, calls: FactoryCall[]): CdFactories {
	const out: Record<string, unknown> = {};
	for (const [factory, name] of Object.entries(MODULE_OF)) {
		out[factory] = (...args: unknown[]) => {
			calls.push({ factory: factory as keyof CdFactories, args });
			if (
				factory === "createSubscriptionDrivers" ||
				factory === "createHealthSources"
			)
				return [];
			if (factory === "createTelemetrySink") return recordingSink();
			if (factory === "createCampPolicy") {
				// Real-enough binding lookup for the rail reader.
				return {
					async binding(campId: string) {
						log.push(`campPolicy.binding:${campId}`);
						return bindings.get(campId);
					},
				};
			}
			return recordingModule(name, log);
		};
	}
	return out as unknown as CdFactories;
}

/** Enforced bindings the fake CampPolicy returns, by Camp id. */
export const bindings = new Map<string, { enforcedRailDigest: string }>();

export function fakeAdapters(
	log: CallLog,
	over: Partial<CdComposeAdapters> = {},
): CdComposeAdapters {
	return {
		gate: () => recordingModule("gate", log),
		resolver: () => recordingModule("resolver", log),
		approvals: () => recordingModule("approvals", log),
		rolloutEngine: () => recordingModule("rolloutEngine", log),
		drift: () => recordingModule("drift", log),
		realizer: () => recordingModule("realizer", log),
		resolvePack: async () => ({}) as never,
		packs: async () => [],
		...over,
	};
}

export const DIGEST_A = `sha256:${"a".repeat(64)}` as const;
export const DIGEST_B = `sha256:${"b".repeat(64)}` as const;

export function fakeTopology(camps: readonly CampTopology[]): TopologyReader {
	return {
		async camps() {
			return camps;
		},
		async camp(campId) {
			return camps.find((c) => c.campId === campId);
		},
	};
}

export function camp(id: string, stationId = "st1"): CampTopology {
	return {
		campId: asCamp(id),
		yardId: "yard-1",
		stationId,
		provider: "vercel",
		regions: ["us-east-1"],
		envType: "production",
		labels: {},
		management: 1,
	};
}

export function staticCatalog(
	entries: readonly RailCatalogEntry[],
): RailCatalog {
	return {
		async active(stationId) {
			return entries.find(
				(e) => e.stationId === stationId && e.status === "active",
			);
		},
		async byDigest(digest) {
			return entries.find((e) => e.railDigest === digest);
		},
	};
}
