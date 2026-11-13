/**
 * The status feed for the availability objectives (L27, design §6.14).
 * Signature frozen by the fleet contract commit (ADR-0182).
 *
 * The authority records one sample per enrollment API request and per NATS
 * callout decision; `tick` turns every finished minute into one `slo.Measured`
 * event per component (`SloMeasuredData` of @hobo/status-page) on the event
 * store, where the status page folds them. See README.md here.
 */
import {
	type AppendOptions,
	type EventInput,
	type JsonObject,
	OptimisticSequenceConflictError,
} from "@hobo/core";
import type { Clock, FleetEventStore, FleetLog } from "@hobo/fleet";
import { STATUS_SIGNAL_EVENTS, type SloMeasuredData } from "@hobo/status-page";

const MINUTE_MS = 60_000;
const APPEND_RETRIES = 8;

type Component = "enrollment-api" | "nats-callout";

// domain-view: the two availability objectives of §6.14 as the status page names them; not a record.
type Objective = Readonly<{
	componentId: string;
	componentLabel: string;
	target: number;
}>;

// public-contract: the component ids, labels and targets the status page shows for the authority (§6.14).
const OBJECTIVES = {
	"enrollment-api": {
		componentId: "fleet-enrollment-api",
		componentLabel: "Fleet enrollment API",
		target: 0.999,
	},
	"nats-callout": {
		componentId: "fleet-nats-callout",
		componentLabel: "Fleet new NATS connections",
		target: 0.9995,
	},
} as const satisfies Readonly<Record<Component, Objective>>;
const COMPONENTS: readonly Component[] = ["enrollment-api", "nats-callout"];
// public-contract: the SLO name and status-page scope of the authority's availability events.
const SLO_NAME = "availability";
const SCOPE_KEY = "service:hobo-fleet-authority";
const APPEND: Omit<AppendOptions, "expectedSeq"> = {
	actor: { kind: "service", id: "fleet-authority" },
	tenant: "hobo-fleet",
};

type Samples = { up: number; total: number };

function minuteOf(ms: number): number {
	return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** The stream each component's availability events go to. */
export function statusStream(component: Component): string {
	return `slo-${OBJECTIVES[component].componentId}`;
}

/** Emits `slo.Measured` events (`SloMeasuredData` of @hobo/status-page) for the enrollment API and the NATS callout. */
export function createStatusFeed(
	options: Readonly<{ store: FleetEventStore; now: Clock; log: FleetLog }>,
): Readonly<{
	record(component: "enrollment-api" | "nats-callout", up: boolean): void;
	tick(): Promise<void>;
}> {
	return statusFeed(options);
}

type StatusFeedOptions = Readonly<{
	store: FleetEventStore;
	now: Clock;
	log: FleetLog;
}>;

type StatusFeed = Readonly<{
	record(component: Component, up: boolean): void;
	tick(): Promise<void>;
}>;

function statusFeed(options: StatusFeedOptions): StatusFeed {
	const first = minuteOf(options.now());
	const samples = new Map<Component, Map<number, Samples>>(
		COMPONENTS.map((component) => [component, new Map()]),
	);
	const next = new Map<Component, number>(
		COMPONENTS.map((component) => [component, first]),
	);
	const heads = new Map<Component, number>();
	let running: Promise<void> = Promise.resolve();

	const headOf = async (component: Component): Promise<number> => {
		const known = heads.get(component);
		if (known !== undefined) return known;
		let head = 0;
		for await (const event of options.store.read(statusStream(component)))
			head = event.seq;
		heads.set(component, head);
		return head;
	};

	const emit = async (component: Component, minute: number): Promise<void> => {
		const objective = OBJECTIVES[component];
		const window = samples.get(component)?.get(minute);
		const measuredAt = new Date(minute + MINUTE_MS).toISOString();
		const data: SloMeasuredData & JsonObject = {
			componentId: objective.componentId,
			componentLabel: objective.componentLabel,
			sloName: SLO_NAME,
			// A minute with no request had no failed one.
			attainment:
				window === undefined || window.total === 0
					? 1
					: window.up / window.total,
			target: objective.target,
			measuredAt,
			scopeKey: SCOPE_KEY,
		};
		const event: EventInput = {
			type: STATUS_SIGNAL_EVENTS.SloMeasured,
			data,
			// Replicas emit each minute once: the first append wins, the others are deduplicated.
			meta: {
				idempotencyKey: `${objective.componentId}/${measuredAt}`,
			},
		};
		const stream = statusStream(component);
		for (let attempt = 0; ; attempt += 1) {
			const expectedSeq = await headOf(component);
			try {
				const result = await options.store.append(stream, [event], {
					...APPEND,
					expectedSeq,
				});
				const written = [...result.appended, ...result.deduped].at(-1);
				heads.set(component, Math.max(expectedSeq, written?.seq ?? 0));
				return;
			} catch (error) {
				heads.delete(component);
				if (
					!(error instanceof OptimisticSequenceConflictError) ||
					attempt >= APPEND_RETRIES
				)
					throw error;
			}
		}
	};

	const tickOnce = async (): Promise<void> => {
		const current = minuteOf(options.now());
		for (const component of COMPONENTS) {
			let minute = next.get(component) ?? first;
			while (minute < current) {
				await emit(component, minute);
				samples.get(component)?.delete(minute);
				minute += MINUTE_MS;
				next.set(component, minute);
			}
		}
	};

	return {
		record(component, up) {
			const minute = Math.max(
				minuteOf(options.now()),
				next.get(component) ?? first,
			);
			const windows = samples.get(component);
			if (windows === undefined) return;
			const window = windows.get(minute) ?? { up: 0, total: 0 };
			window.total += 1;
			if (up) window.up += 1;
			windows.set(minute, window);
		},
		tick() {
			const ticking = running.then(tickOnce);
			running = ticking.catch(() => {});
			return ticking;
		},
	};
}
