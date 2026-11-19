/* oxlint-disable anti-slop/no-unknown-parameters -- SAFETY: the HTTP edge: a response body is any JSON the service reports, only stringified. */

import {
	type CampId,
	CampManagement,
	type CampReconciler,
	type FeedRequest,
	type FeedResponse,
} from "@hobo/cd";
import { defaultRetention } from "@hobo/cd/compose";
import {
	type CdServiceHost,
	createCdControlApi,
	createCdService,
	type TickReport,
} from "@hobo/cd/service";
import { EventStoreError, type SubscriptionLease } from "@hobo/core";
import type { CdRuntime } from "./cd-runtime.js";

export function cdJson(status: number, value: unknown): FeedResponse {
	return {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
		body: new TextEncoder().encode(JSON.stringify(value)),
	};
}

export type CdReadiness = "service" | "composed";

export const FLEET_PASS_SUBSCRIPTION = "cd:vercel:fleet-pass";
export const DEFAULT_PASS_DEADLINE_MS = 240_000;

export type CdPassCampReport = Readonly<{
	campId: CampId;
	ok: boolean;
	detail: string;
}>;

export type CdPassReport = Readonly<{
	tick: TickReport;
	reconciled: readonly CdPassCampReport[];
	skipped: boolean;
}>;

export type CdHost = Readonly<{
	service: CdServiceHost;
	holderId: string;
	managed: readonly CampId[];
	reconcilers: number;
	refusals: readonly string[];
	pathPrefix: string;
	passDeadlineMs: number;
	handle(request: FeedRequest, signal: AbortSignal): Promise<FeedResponse>;
	pass(signal?: AbortSignal): Promise<CdPassReport>;
}>;

function isLeaseConflict<T>(error: T): boolean {
	if (error instanceof EventStoreError)
		return (
			error.code === "STALE_FENCE" || error.code.endsWith("LEASE_CONFLICT")
		);
	return (
		error instanceof Error &&
		"code" in error &&
		(String(error.code) === "STALE_FENCE" ||
			String(error.code).endsWith("LEASE_CONFLICT"))
	);
}

function abortErrorOf(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error("cd pass aborted");
}

export async function composeCdHost(
	input: Readonly<{
		runtime: CdRuntime;
		holderId: string;
		principalId?: string;
		readiness?: CdReadiness;
		fleetPassLease?: boolean;
		passDeadlineMs?: number;
	}>,
): Promise<CdHost> {
	const { runtime } = input;
	const { cd, config } = runtime;
	const passDeadlineMs = input.passDeadlineMs ?? DEFAULT_PASS_DEADLINE_MS;
	const refusals: string[] = [];
	const managed: CampId[] = (await cd.topology.camps())
		.filter((camp) => camp.management === CampManagement.MANAGED)
		.map((camp) => camp.campId);
	const reconcilers: CampReconciler[] = [];
	if (managed.length > 0) {
		try {
			reconcilers.push(runtime.conductor(managed, input.holderId));
		} catch (error) {
			refusals.push(error instanceof Error ? error.message : String(error));
		}
	}
	const service = createCdService({
		store: runtime.store,
		tenant: config.tenant,
		now: runtime.ctx.now,
		cd,
		reconcilers,
		retention: [defaultRetention()],
		tickIntervalMs: config.tickIntervalMs,
		principal: { kind: "service", id: input.principalId ?? input.holderId },
		telemetry: cd.sink,
	});
	const api = createCdControlApi({
		store: runtime.store,
		tenant: config.tenant,
		now: runtime.ctx.now,
		cd,
		topology: cd.topology,
		service,
		telemetry: cd.sink,
	});
	const readiness = input.readiness ?? "service";
	let passSucceeded = false;
	const storeHealthy = () =>
		service.health().checks.some((check) => check.name === "store" && check.ok);
	const ready = () =>
		readiness === "service"
			? refusals.length === 0 && service.ready()
			: refusals.length === 0 && passSucceeded && storeHealthy();

	async function claimFleetPass(): Promise<
		Readonly<{ held: boolean; lease?: SubscriptionLease }>
	> {
		if (input.fleetPassLease !== true) return { held: true };
		const claim = runtime.store.claimSubscription?.bind(runtime.store);
		if (claim === undefined) return { held: false };
		try {
			const lease = await claim({
				subscriptionId: FLEET_PASS_SUBSCRIPTION,
				partitionId: config.tenant,
				holderId: input.holderId,
				leaseTtlMs: passDeadlineMs,
			});
			return { held: true, lease };
		} catch (error) {
			if (isLeaseConflict(error)) return { held: false };
			throw error;
		}
	}

	async function releaseFleetPass(
		lease: SubscriptionLease | undefined,
	): Promise<void> {
		if (lease === undefined) return;
		await runtime.store
			.releaseSubscription?.({
				subscriptionId: FLEET_PASS_SUBSCRIPTION,
				partitionId: config.tenant,
				holderId: input.holderId,
				fenceToken: lease.fenceToken,
			})
			.catch(() => undefined);
	}

	async function runPass(signal: AbortSignal): Promise<CdPassReport> {
		const fleet = await claimFleetPass();
		if (!fleet.held)
			return Object.freeze({
				tick: Object.freeze({
					atMs: runtime.ctx.now(),
					store: storeHealthy(),
					steps: Object.freeze([]),
				}),
				reconciled: Object.freeze([]),
				skipped: true,
			});
		try {
			const reconciled: CdPassCampReport[] = [];
			const [reconciler] = reconcilers;
			if (managed.length > 0 && reconciler === undefined) {
				const detail = refusals[0] ?? "cd conductor did not compose";
				throw new Error(detail);
			}
			if (reconciler !== undefined)
				for (const campId of managed) {
					if (signal.aborted) break;
					try {
						const observed = await reconciler.reconcileOnce(campId, {
							...runtime.ctx,
							signal,
						});
						reconciled.push(
							Object.freeze({
								campId,
								ok: observed.reasons.length === 0,
								detail:
									observed.reasons[0]?.message ?? `status ${observed.status}`,
							}),
						);
					} catch (error) {
						reconciled.push(
							Object.freeze({
								campId,
								ok: false,
								detail: error instanceof Error ? error.message : String(error),
							}),
						);
					}
				}
			if (signal.aborted) throw abortErrorOf(signal);
			const tick = await service.tick();
			passSucceeded = true;
			return Object.freeze({
				tick,
				reconciled: Object.freeze(reconciled),
				skipped: false,
			});
		} finally {
			await releaseFleetPass(fleet.lease);
		}
	}

	let inFlightPass: Promise<CdPassReport> | undefined;

	function pass(external?: AbortSignal): Promise<CdPassReport> {
		if (inFlightPass !== undefined) return inFlightPass;
		const deadline = new AbortController();
		const signal =
			external === undefined
				? deadline.signal
				: AbortSignal.any([deadline.signal, external]);
		const timer = setTimeout(() => {
			deadline.abort(
				new Error(`cd pass deadline exceeded after ${passDeadlineMs} ms`),
			);
		}, passDeadlineMs);
		timer.unref?.();
		let onAbort: (() => void) | undefined;
		const abortRejection = new Promise<never>((_, reject) => {
			onAbort = () => reject(abortErrorOf(signal));
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		const current = (async (): Promise<CdPassReport> => {
			try {
				return await Promise.race([runPass(signal), abortRejection]);
			} finally {
				clearTimeout(timer);
				if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
			}
		})();
		const tracked = current.finally(() => {
			if (inFlightPass === tracked) inFlightPass = undefined;
		});
		inFlightPass = tracked;
		return tracked;
	}

	return Object.freeze({
		service,
		holderId: input.holderId,
		managed,
		reconcilers: reconcilers.length,
		refusals,
		pathPrefix: api.pathPrefix,
		passDeadlineMs,
		pass,
		async handle(request: FeedRequest, signal: AbortSignal) {
			const path = request.path.split("?")[0] ?? "/";
			if (path === "/healthz") return cdJson(200, { ok: true });
			if (path === "/readyz")
				return cdJson(ready() ? 200 : 503, {
					...service.health(),
					ok: ready(),
					readiness,
					simulated: config.simulate,
					refusals,
				});
			const prefix = api.pathPrefix;
			const onMount =
				path === prefix ||
				path === prefix.replace(/\/$/u, "") ||
				path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
			if (!onMount) return cdJson(404, { ok: false, code: "not-found" });
			return api.handle(request, signal);
		},
	});
}
