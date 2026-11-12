// `createCdService` — the long-running CD host (WP12, plan 0024, C13).
//
// Modelled on the CI relay host: one tick loop drives every module's `tick`
// in a fixed order (sources → inventory → pipelines → promotions →
// verification → rollouts → fan-out → failover → posture → previews →
// retention), and a supervisor keeps each reconciler's `run` loop alive.
// The host makes no delivery decision itself: every step is a module's own
// "safe to repeat" tick, so a crash anywhere resumes by observation.
//
// Readiness reflects the journal (a probe each tick), reconciler leases (each
// run loop alive) and source health (the sources step). Drain stops the loop,
// aborts the reconcilers so they release their `cd:camp:<id>` leases, and
// waits for the in-flight tick, bounded by the caller's deadline signal.
import type { PrincipalRef } from "@hobo/core";
import type { RetentionPolicyRecord } from "../_generated/cd_pb.js";
import { CD_DEFAULTS } from "../events.js";
import type {
	CampReconciler,
	CdBase,
	CdContext,
	CdService,
	ContinuousDelivery,
	HealthReport,
	OtelAttributes,
	OtelMetricPoint,
	TelemetrySink,
} from "../ports.js";
import {
	isStoreFailure,
	messageOf,
	SERVICE_FAILURES,
	type ServiceFailureCode,
	serviceReason,
} from "./errors.js";

// public-contract: the tick steps, in the order the service runs them.
export const CD_SERVICE_STEPS = Object.freeze([
	"sources",
	"inventory",
	"pipelines",
	"promotions",
	"verification",
	"rollouts",
	"fanout",
	"failover",
	"posture",
	"previews",
	"retention",
] as const);

export type CdServiceStep = (typeof CD_SERVICE_STEPS)[number];

// public-contract: metric names the service emits through TelemetrySink.
export const CD_SERVICE_METRICS = Object.freeze({
	stepMs: "hobo.cd.service.step_ms",
	stepFailures: "hobo.cd.service.step_failures",
	tickMs: "hobo.cd.service.tick_ms",
	ready: "hobo.cd.service.ready",
	storeUp: "hobo.cd.service.store_up",
	reconcilerRestarts: "hobo.cd.service.reconciler_restarts",
	retentionRetired: "hobo.cd.service.retention_retired",
	drainMs: "hobo.cd.service.drain_ms",
});

/** Retention is a sweep, not a hot loop: once an hour unless configured. */
export const CD_SERVICE_RETENTION_INTERVAL_MS = 3_600_000;

export class CdServiceError extends Error {
	readonly code: ServiceFailureCode;
	readonly remediation: string;
	constructor(code: ServiceFailureCode, message: string) {
		super(message);
		this.name = "CdServiceError";
		this.code = code;
		this.remediation = SERVICE_FAILURES[code].remediation;
	}
}

export type CdServiceDeps = CdBase & {
	readonly cd: ContinuousDelivery;
	readonly reconcilers: readonly CampReconciler[];
	readonly retention: readonly RetentionPolicyRecord[];
	readonly tickIntervalMs: number;
	readonly principal: PrincipalRef;
	/** Service metrics sink. Failures to emit never affect the loop. */
	readonly telemetry?: TelemetrySink;
	/** Reconciler restart backoff (default 1 s doubling to the 30 s lease TTL). */
	readonly reconcilerBackoff?: Readonly<{ baseMs: number; maxMs: number }>;
	/** Minimum time between retention sweeps (default 1 h). */
	readonly retentionIntervalMs?: number;
	/** A step still running after this long is reported failed and skipped until it settles (default 30 × tick, ≥ 30 s). */
	readonly stepTimeoutMs?: number;
};

export type StepReport = Readonly<{
	step: CdServiceStep;
	ok: boolean;
	ms: number;
	skipped?: boolean;
	reason?: ReturnType<typeof serviceReason>;
}>;

export type TickReport = Readonly<{
	atMs: number;
	store: boolean;
	steps: readonly StepReport[];
}>;

export type DrainReport = Readonly<{
	completed: boolean;
	durationMs: number;
	pending: readonly string[];
}>;

export interface CdServiceHost extends CdService {
	/** Run one tick now (tests, `hobo up`). Ticks never overlap. */
	tick(): Promise<TickReport>;
	/** Readiness detail: one check per dependency and step. */
	health(): HealthReport;
}

type StepState = {
	ok: boolean;
	detail: string;
	running?: Promise<unknown> | undefined;
};

type ReconcilerState = {
	readonly reconciler: CampReconciler;
	running: boolean;
	detail: string;
	restarts: number;
	run?: Promise<void>;
	timer?: ReturnType<typeof setTimeout>;
};

export function createCdService(d: CdServiceDeps): CdServiceHost {
	const tickMs = Math.max(1, d.tickIntervalMs);
	const backoff = d.reconcilerBackoff ?? {
		baseMs: 1_000,
		maxMs: CD_DEFAULTS.leaseTtlMs,
	};
	const retentionEvery =
		d.retentionIntervalMs ?? CD_SERVICE_RETENTION_INTERVAL_MS;
	const stepTimeout = d.stepTimeoutMs ?? Math.max(30 * tickMs, 30_000);

	let started = false;
	let draining = false;
	let storeOk = false;
	let storeDetail = "not probed yet";
	let lastRetentionMs: number | undefined;
	let loopTimer: ReturnType<typeof setTimeout> | undefined;
	let inflight: Promise<TickReport> | undefined;
	let lastDrain: DrainReport | undefined;
	const steps = new Map<CdServiceStep, StepState>();
	const runAbort = new AbortController();
	const reconcilers: ReconcilerState[] = d.reconcilers.map((reconciler) => ({
		reconciler,
		running: false,
		detail: "not started",
		restarts: 0,
	}));

	// ── Telemetry ─────────────────────────────────────────────────────────
	function point(
		name: string,
		kind: OtelMetricPoint["kind"],
		value: number,
		attributes: OtelAttributes,
		unit = "1",
	): OtelMetricPoint {
		return { name, kind, value, unit, atMs: d.now(), attributes };
	}
	function emit(points: readonly OtelMetricPoint[]): void {
		if (!d.telemetry || points.length === 0) return;
		d.telemetry.metrics(points).catch(() => {
			// Telemetry is best-effort; a broken exporter never stops delivery.
		});
	}

	function ctx(): CdContext {
		return {
			tenant: d.tenant,
			principal: d.principal,
			now: d.now,
			signal: runAbort.signal,
		};
	}

	// ── Steps ─────────────────────────────────────────────────────────────
	function stepFn(step: CdServiceStep): (() => Promise<unknown>) | undefined {
		const c = ctx();
		const cd = d.cd;
		switch (step) {
			case "sources":
				return () => cd.sources.tick(c);
			case "inventory":
				return () => cd.inventory.tick(c);
			case "pipelines":
				return () => cd.pipelines.tick(c);
			case "promotions":
				return () => cd.promotions.tick(c);
			case "verification":
				return () => cd.verification.tick(c);
			case "rollouts":
				return () => cd.rollouts.tick(c);
			case "fanout":
				return () => cd.fanout.tick(c);
			case "failover":
				return () => cd.failover.tick(c);
			case "posture":
				return () => cd.posture.tick(c);
			case "previews":
				return () => cd.promotions.expirePreviews(c);
			case "retention": {
				const due =
					lastRetentionMs === undefined ||
					d.now() - lastRetentionMs >= retentionEvery;
				if (!due) return undefined;
				return async () => {
					let retired = 0;
					for (const policy of d.retention)
						retired += (await cd.freight.retire(policy, c)).length;
					lastRetentionMs = d.now();
					emit([
						point(CD_SERVICE_METRICS.retentionRetired, "counter", retired, {}),
					]);
				};
			}
		}
	}

	async function runStep(step: CdServiceStep): Promise<StepReport> {
		const prior = steps.get(step);
		if (prior?.running) {
			return {
				step,
				ok: false,
				ms: 0,
				skipped: true,
				reason: serviceReason(
					"step-failed",
					`${step} is still running from an earlier tick`,
					step,
				),
			};
		}
		const fn = stepFn(step);
		if (!fn) return { step, ok: true, ms: 0, skipped: true };
		const startedAt = performance.now();
		const running = fn();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), stepTimeout);
		});
		try {
			const result = await Promise.race([
				running.then(() => "done" as const),
				timedOut,
			]);
			if (result === "timeout") {
				const state: StepState = {
					ok: false,
					detail: `step-failed: ${step} exceeded ${stepTimeout} ms`,
					running,
				};
				steps.set(step, state);
				running.then(
					() => {
						state.running = undefined;
					},
					(error: unknown) => {
						state.running = undefined;
						state.detail = `step-failed: ${messageOf(error)}`;
					},
				);
				return {
					step,
					ok: false,
					ms: performance.now() - startedAt,
					reason: serviceReason(
						"step-failed",
						`${step} exceeded its ${stepTimeout} ms deadline`,
						step,
					),
				};
			}
			steps.set(step, { ok: true, detail: "ok" });
			return { step, ok: true, ms: performance.now() - startedAt };
		} catch (error) {
			if (isStoreFailure(error)) {
				storeOk = false;
				storeDetail = `store-unavailable: ${messageOf(error)}`;
			}
			steps.set(step, {
				ok: false,
				detail: `step-failed: ${messageOf(error)}`,
			});
			return {
				step,
				ok: false,
				ms: performance.now() - startedAt,
				reason: serviceReason(
					"step-failed",
					`${step}: ${messageOf(error)}`,
					step,
				),
			};
		} finally {
			clearTimeout(timer);
		}
	}

	async function probeStore(): Promise<boolean> {
		try {
			for await (const _ of d.store.readAll({ limit: 1 })) break;
			storeOk = true;
			storeDetail = "ok";
		} catch (error) {
			storeOk = false;
			storeDetail = `store-unavailable: ${messageOf(error)}`;
		}
		return storeOk;
	}

	async function runTick(): Promise<TickReport> {
		const atMs = d.now();
		const startedAt = performance.now();
		const reports: StepReport[] = [];
		const store = await probeStore();
		if (store) {
			for (const step of CD_SERVICE_STEPS) {
				if (draining && started) break;
				reports.push(await runStep(step));
			}
		}
		const points: OtelMetricPoint[] = [
			point(
				CD_SERVICE_METRICS.tickMs,
				"histogram",
				performance.now() - startedAt,
				{},
				"ms",
			),
			point(CD_SERVICE_METRICS.storeUp, "gauge", storeOk ? 1 : 0, {}),
			point(CD_SERVICE_METRICS.ready, "gauge", ready() ? 1 : 0, {}),
		];
		for (const r of reports) {
			if (r.skipped && r.ok) continue;
			points.push(
				point(
					CD_SERVICE_METRICS.stepMs,
					"histogram",
					r.ms,
					{ step: r.step, outcome: r.ok ? "ok" : "failed" },
					"ms",
				),
			);
			if (!r.ok)
				points.push(
					point(CD_SERVICE_METRICS.stepFailures, "counter", 1, {
						step: r.step,
					}),
				);
		}
		emit(points);
		return { atMs, store: storeOk, steps: reports };
	}

	function tick(): Promise<TickReport> {
		// Ticks never overlap: a caller during a tick gets the next one.
		const next = (inflight ?? Promise.resolve())
			.catch(() => undefined)
			.then(runTick);
		inflight = next;
		next
			.finally(() => {
				if (inflight === next) inflight = undefined;
			})
			.catch(() => undefined);
		return next;
	}

	function schedule(): void {
		if (draining) return;
		loopTimer = setTimeout(() => {
			loopTimer = undefined;
			tick()
				.finally(schedule)
				.catch(() => undefined);
		}, tickMs);
		loopTimer.unref?.();
	}

	// ── Reconciler supervision ────────────────────────────────────────────
	function superviseReconciler(state: ReconcilerState): void {
		if (draining) return;
		state.running = true;
		state.detail = "running";
		const startedAt = d.now();
		const done = (error: unknown) => {
			state.running = false;
			if (draining) {
				state.detail = "drained";
				return;
			}
			if (d.now() - startedAt >= backoff.maxMs) state.restarts = 0;
			state.restarts += 1;
			state.detail = `reconciler-crashed: ${error === undefined ? "run loop returned before drain" : messageOf(error)}`;
			emit([
				point(CD_SERVICE_METRICS.reconcilerRestarts, "counter", 1, {
					reconciler: state.reconciler.reconcilerId,
				}),
			]);
			const wait = Math.min(
				backoff.maxMs,
				backoff.baseMs * 2 ** (state.restarts - 1),
			);
			state.timer = setTimeout(() => superviseReconciler(state), wait);
			state.timer.unref?.();
		};
		let run: Promise<void>;
		try {
			run = state.reconciler.run(runAbort.signal);
		} catch (error) {
			run = Promise.reject(error);
		}
		state.run = run.then(
			() => done(undefined),
			(error: unknown) => done(error),
		);
	}

	// ── Readiness ─────────────────────────────────────────────────────────
	function ready(): boolean {
		if (!started || draining) return false;
		if (!storeOk) return false;
		if (reconcilers.some((r) => !r.running)) return false;
		return steps.get("sources")?.ok === true;
	}

	function health(): HealthReport {
		const checks: { name: string; ok: boolean; detail: string }[] = [
			{
				name: "started",
				ok: started && !draining,
				detail: !started ? "not started" : draining ? "draining" : "ok",
			},
			{ name: "store", ok: storeOk, detail: storeDetail },
		];
		for (const r of reconcilers) {
			checks.push({
				name: `reconciler:${r.reconciler.reconcilerId}`,
				ok: r.running,
				detail: r.detail,
			});
		}
		for (const step of CD_SERVICE_STEPS) {
			const s = steps.get(step);
			checks.push({
				name: `step:${step}`,
				ok: s?.ok ?? true,
				detail: s?.detail ?? "not run yet",
			});
		}
		if (lastDrain) {
			checks.push({
				name: "drain",
				ok: lastDrain.completed,
				detail: lastDrain.completed
					? `completed in ${Math.round(lastDrain.durationMs)} ms`
					: `drain-deadline-exceeded: still waiting on ${lastDrain.pending.join(", ")}`,
			});
		}
		return { ok: ready(), checks };
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────
	async function start(): Promise<void> {
		if (started)
			throw new CdServiceError(
				"already-started",
				"this CD service instance was already started",
			);
		started = true;
		for (const r of reconcilers) superviseReconciler(r);
		await tick();
		schedule();
	}

	async function drain(signal: AbortSignal): Promise<void> {
		const startedAt = performance.now();
		draining = true;
		if (loopTimer !== undefined) clearTimeout(loopTimer);
		loopTimer = undefined;
		for (const r of reconcilers)
			if (r.timer !== undefined) clearTimeout(r.timer);
		runAbort.abort(new CdServiceError("not-ready", "CD service draining"));
		const pending = new Map<string, Promise<unknown>>();
		if (inflight)
			pending.set(
				"tick",
				inflight.catch(() => undefined),
			);
		for (const r of reconcilers) {
			if (r.run && r.running)
				pending.set(`reconciler:${r.reconciler.reconcilerId}`, r.run);
		}
		const settled = new Set<string>();
		const all = Promise.all(
			[...pending].map(([name, p]) =>
				p.then(() => {
					settled.add(name);
				}),
			),
		).then(() => true as const);
		const expired = new Promise<false>((resolve) => {
			if (signal.aborted) resolve(false);
			else
				signal.addEventListener("abort", () => resolve(false), { once: true });
		});
		const completed =
			pending.size === 0 ? true : await Promise.race([all, expired]);
		const remaining = [...pending.keys()].filter((n) => !settled.has(n));
		lastDrain = {
			completed,
			durationMs: performance.now() - startedAt,
			pending: remaining,
		};
		if (!started && pending.size === 0) {
			lastDrain = undefined;
			return;
		}
		emit([
			point(
				CD_SERVICE_METRICS.drainMs,
				"histogram",
				lastDrain.durationMs,
				{ completed },
				"ms",
			),
			point(CD_SERVICE_METRICS.ready, "gauge", 0, {}),
		]);
	}

	return Object.freeze({ start, ready, drain, tick, health });
}
