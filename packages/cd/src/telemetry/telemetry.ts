// `createCdTelemetry` (WP19, C13): DORA four keys, reconcile lag and health
// as queries over the DORA projection (a materialized view of the event
// store), plus `collect`/`export` that turn them — and the fleet and policy
// gauges — into OTel metric points for a TelemetrySink.
import type {
	CampId,
	CdBase,
	CdContext,
	CdTelemetry,
	DoraMetrics,
	HealthReport,
	OtelMetricPoint,
	TelemetrySink,
} from "../ports.js";
import {
	computeDora,
	computeReconcileLag,
	createDoraProjection,
	DAY_MS,
} from "./dora.js";
import { TelemetryError } from "./errors.js";
import { collectFleetMetrics, type FleetSources } from "./fleet.js";
import { CD_METRICS, HOBO_ATTR } from "./semconv.js";

// public-contract: default DORA window for collected gauges (30 days).
export const DORA_DEFAULT_WINDOW_MS = 30 * DAY_MS;

export type CdTelemetryDeps = CdBase &
	Readonly<{
		sink?: TelemetrySink;
		fleet?: FleetSources;
		doraWindowMs?: number;
	}>;

export type CdTelemetryService = CdTelemetry &
	Readonly<{
		/** Every CD gauge at `ctx.now()`: DORA, reconcile lag, fleet, policy. */
		collect(ctx: CdContext): Promise<OtelMetricPoint[]>;
		/** `collect` then push to the sink; never throws (health records it). */
		export(ctx: CdContext): Promise<number>;
	}>;

type Check = { ok: boolean; detail: string };

export function createCdTelemetry(d: CdTelemetryDeps): CdTelemetryService {
	const projection = createDoraProjection(d.store, d.tenant);
	const windowMs = d.doraWindowMs ?? DORA_DEFAULT_WINDOW_MS;
	const checks = new Map<string, Check>([
		["journal", { ok: true, detail: "not read yet" }],
		[
			"exporter",
			d.sink
				? { ok: true, detail: "no export yet" }
				: { ok: true, detail: "no sink configured" },
		],
		[
			"fleet-sources",
			d.fleet
				? { ok: true, detail: "not collected yet" }
				: { ok: true, detail: "no fleet sources configured" },
		],
	]);

	function guard(ctx: CdContext): void {
		if (ctx.tenant !== d.tenant)
			throw new TelemetryError(
				"telemetry-tenant-mismatch",
				`telemetry serves tenant ${d.tenant}, request names ${ctx.tenant}`,
			);
	}

	async function refresh(): Promise<void> {
		try {
			const read = await projection.refresh();
			checks.set("journal", {
				ok: true,
				detail: `caught up (+${read} events)`,
			});
		} catch (error) {
			checks.set("journal", {
				ok: false,
				detail: `journal read failed: ${error instanceof Error ? error.message : String(error)}`,
			});
			throw error;
		}
	}

	async function dora(
		input: Readonly<{ windowMs: number; campIds?: readonly CampId[] }>,
		ctx: CdContext,
	): Promise<DoraMetrics> {
		guard(ctx);
		await refresh();
		return computeDora(projection.facts(), {
			windowMs: input.windowMs,
			nowMs: ctx.now(),
			...(input.campIds ? { campIds: input.campIds } : {}),
		});
	}

	async function reconcileLagMs(
		campId: CampId,
		ctx: CdContext,
	): Promise<number | undefined> {
		guard(ctx);
		await refresh();
		return computeReconcileLag(
			projection.specs(campId),
			projection.converged(campId),
			ctx.now(),
		);
	}

	async function collect(ctx: CdContext): Promise<OtelMetricPoint[]> {
		guard(ctx);
		await refresh();
		const atMs = ctx.now();
		const k = computeDora(projection.facts(), { windowMs, nowMs: atMs });
		const window = { "hobo.cd.dora.window": `${windowMs}ms` };
		const points: OtelMetricPoint[] = [
			{
				name: CD_METRICS.doraDeploymentFrequency,
				kind: "gauge",
				value: k.deploymentFrequencyPerDay,
				unit: "{deployment}/d",
				atMs,
				attributes: window,
			},
			{
				name: CD_METRICS.doraLeadTime,
				kind: "gauge",
				value: k.leadTimeMsP50 / 1_000,
				unit: "s",
				atMs,
				attributes: window,
			},
			{
				name: CD_METRICS.doraChangeFailureRate,
				kind: "gauge",
				value: k.changeFailureRate,
				unit: "1",
				atMs,
				attributes: window,
			},
			{
				name: CD_METRICS.doraTimeToRestore,
				kind: "gauge",
				value: k.timeToRestoreMsP50 / 1_000,
				unit: "s",
				atMs,
				attributes: window,
			},
		];
		for (const campId of projection.camps()) {
			const lag = computeReconcileLag(
				projection.specs(campId),
				projection.converged(campId),
				atMs,
			);
			if (lag !== undefined)
				points.push({
					name: CD_METRICS.reconcileLag,
					kind: "gauge",
					value: lag / 1_000,
					unit: "s",
					atMs,
					attributes: { [HOBO_ATTR.campId]: campId },
				});
		}
		if (d.fleet) {
			try {
				points.push(...(await collectFleetMetrics(d.fleet, atMs)));
				checks.set("fleet-sources", { ok: true, detail: "collected" });
			} catch (error) {
				checks.set("fleet-sources", {
					ok: false,
					detail: `fleet read failed: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
		return points;
	}

	return {
		dora,
		reconcileLagMs,
		collect,
		async export(ctx) {
			let points: OtelMetricPoint[];
			try {
				points = await collect(ctx);
			} catch {
				return 0;
			}
			if (!d.sink) return points.length;
			try {
				await d.sink.metrics(points);
				checks.set("exporter", {
					ok: true,
					detail: `exported ${points.length} points`,
				});
			} catch (error) {
				checks.set("exporter", {
					ok: false,
					detail: `export failed: ${error instanceof Error ? error.message : String(error)}`,
				});
				d.sink
					.metrics([
						{
							name: CD_METRICS.exportFailures,
							kind: "counter",
							value: 1,
							unit: "1",
							atMs: ctx.now(),
							attributes: {},
						},
					])
					.catch(() => undefined);
			}
			return points.length;
		},
		health(): HealthReport {
			const list = [...checks.entries()].map(([name, c]) => ({
				name,
				ok: c.ok,
				detail: c.detail,
			}));
			return { ok: list.every((c) => c.ok), checks: list };
		},
	};
}
