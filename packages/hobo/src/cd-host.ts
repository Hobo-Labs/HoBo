/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: the HTTP edge: a response body is any JSON the service reports, only stringified, and refusal codes are decoded from error values at this boundary. */

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

// public-contract: shared subscription lease id every Vercel CD instance claims; deployed holders coordinate on this exact value.
export const FLEET_PASS_SUBSCRIPTION = "cd:vercel:fleet-pass";
export const DEFAULT_PASS_DEADLINE_MS = 240_000;
// public-contract: the fleet pass lease must outlive the pass deadline with a margin over a Vercel function's 300 s maxDuration, so the lease never expires mid-pass.
export const DEFAULT_FLEET_PASS_LEASE_TTL_MS = 360_000;
// public-contract: durable readiness record every holder appends after a fully successful pass; /readyz reads it back instead of any process-local latch.
export const HOST_PASS_STREAM = "cd-host-pass";
// public-contract: event type every holder appends to HOST_PASS_STREAM after a successful pass.
export const HOST_PASS_SUCCEEDED = "host.PassSucceeded";
// public-contract: refusal code recorded when the topology declares Camps but none are MANAGED.
export const CD_NO_MANAGED_CAMPS = "cd-no-managed-camps";
// public-contract: how many tail events of the readiness stream /readyz folds; the latest host.PassSucceeded among them wins.
const HOST_PASS_LOOKBACK = 8;

export type CdPassCampReport = Readonly<{
	campId: CampId;
	ok: boolean;
	detail: string;
}>;

export type CdPassReport = Readonly<{
	tick: TickReport;
	reconciled: readonly CdPassCampReport[];
	skipped: boolean;
	skipReason?: string;
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

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function passSucceededAtMs(data: unknown): number | undefined {
	if (data === null || typeof data !== "object") return undefined;
	for (const [key, value] of Object.entries(data)) {
		if (key !== "atMs") continue;
		return typeof value === "number" && Number.isFinite(value)
			? value
			: undefined;
	}
	return undefined;
}

function refusalCodeOf(error: unknown): string {
	if (
		error instanceof Error &&
		"code" in error &&
		isString(error.code) &&
		error.code.length > 0
	)
		return error.code;
	return "cd-host-refused";
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
	const passRecordMaxAgeMs = 2 * passDeadlineMs;
	const fleetPassLeaseTtlMs = Math.max(
		DEFAULT_FLEET_PASS_LEASE_TTL_MS,
		passDeadlineMs + 120_000,
	);
	const servicePrincipal = {
		kind: "service" as const,
		id: input.principalId ?? input.holderId,
	};
	const refusals: string[] = [];
	const camps = await cd.topology.camps();
	const managed: CampId[] = camps
		.filter((camp) => camp.management === CampManagement.MANAGED)
		.map((camp) => camp.campId);
	if (camps.length > 0 && managed.length === 0)
		refusals.push(CD_NO_MANAGED_CAMPS);
	const reconcilers: CampReconciler[] = [];
	if (managed.length > 0) {
		try {
			reconcilers.push(runtime.conductor(managed, input.holderId));
		} catch (error) {
			refusals.push(refusalCodeOf(error));
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
		principal: servicePrincipal,
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
	const storeHealthy = () =>
		service.health().checks.some((check) => check.name === "store" && check.ok);
	const serviceReady = () => refusals.length === 0 && service.ready();

	async function hostPassRevision(): Promise<number> {
		const head = runtime.store.getStreamHead?.(HOST_PASS_STREAM);
		if (head !== undefined) return head.revision;
		let revision = 0;
		for await (const event of runtime.store.read(HOST_PASS_STREAM))
			revision = event.seq;
		return revision;
	}

	async function recordSuccessfulPass(campsReconciled: number): Promise<void> {
		const atMs = runtime.ctx.now();
		const event = {
			type: HOST_PASS_SUCCEEDED,
			data: { atMs, camps: campsReconciled },
			meta: { idempotencyKey: `host-pass:${input.holderId}:${atMs}` },
		};
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const expectedSeq = await hostPassRevision();
			const appended = await runtime.store
				.append(HOST_PASS_STREAM, [event], {
					expectedSeq,
					actor: servicePrincipal,
					tenant: config.tenant,
				})
				.then(
					() => true,
					() => false,
				);
			if (appended) return;
		}
	}

	async function lastSuccessfulPassAtMs(): Promise<number | undefined> {
		try {
			const head = runtime.store.getStreamHead?.(HOST_PASS_STREAM);
			const fromSeq =
				head !== undefined
					? Math.max(1, head.revision - (HOST_PASS_LOOKBACK - 1))
					: 1;
			let atMs: number | undefined;
			for await (const event of runtime.store.read(HOST_PASS_STREAM, fromSeq)) {
				if (event.type !== HOST_PASS_SUCCEEDED) continue;
				const recorded = passSucceededAtMs(event.data);
				if (recorded !== undefined) {
					atMs = recorded;
					continue;
				}
				const parsed = Date.parse(event.ts);
				if (!Number.isNaN(parsed)) atMs = parsed;
			}
			return atMs;
		} catch {
			return undefined;
		}
	}

	async function probeJournal(): Promise<boolean> {
		try {
			for await (const _ of runtime.store.readAll({ limit: 1 })) break;
			return true;
		} catch {
			return false;
		}
	}

	async function composedReady(): Promise<boolean> {
		if (refusals.length > 0) return false;
		const [passedAtMs, journalOk] = await Promise.all([
			lastSuccessfulPassAtMs(),
			probeJournal(),
		]);
		if (!journalOk || passedAtMs === undefined || !storeHealthy()) return false;
		return runtime.ctx.now() - passedAtMs <= passRecordMaxAgeMs;
	}

	async function claimFleetPass(): Promise<
		Readonly<{
			held: boolean;
			lease?: SubscriptionLease;
			skipReason?: string;
		}>
	> {
		if (input.fleetPassLease !== true) return { held: true };
		const claim = runtime.store.claimSubscription?.bind(runtime.store);
		if (claim === undefined)
			return { held: false, skipReason: "fleet-pass-unsupported" };
		try {
			const lease = await claim({
				subscriptionId: FLEET_PASS_SUBSCRIPTION,
				partitionId: config.tenant,
				holderId: input.holderId,
				leaseTtlMs: fleetPassLeaseTtlMs,
			});
			return { held: true, lease };
		} catch (error) {
			if (isLeaseConflict(error))
				return { held: false, skipReason: "fleet-pass-lease-held" };
			throw error;
		}
	}

	async function releaseFleetPass(
		lease: SubscriptionLease | undefined,
	): Promise<void> {
		if (lease === undefined) return;
		const release = runtime.store.releaseSubscription;
		if (release === undefined) return;
		await release
			.call(runtime.store, {
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
				...(fleet.skipReason !== undefined
					? { skipReason: fleet.skipReason }
					: undefined),
			});
		try {
			const reconciled: CdPassCampReport[] = [];
			const [reconciler] = reconcilers;
			if (managed.length > 0 && reconciler === undefined) {
				throw new Error(refusals[0] ?? "cd conductor did not compose");
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
			if (signal.aborted) throw abortErrorOf(signal);
			if (reconciled.every((entry) => entry.ok) && tick.store)
				await recordSuccessfulPass(reconciled.length);
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
		const running = runPass(signal);
		const bounded = (async (): Promise<CdPassReport> => {
			try {
				return await Promise.race([running, abortRejection]);
			} finally {
				clearTimeout(timer);
				if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
			}
		})();
		const tracked = running.finally(() => {
			if (inFlightPass === tracked) inFlightPass = undefined;
		});
		tracked.catch(() => undefined);
		inFlightPass = tracked;
		return bounded;
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
			if (path === "/readyz") {
				const ok =
					readiness === "service" ? serviceReady() : await composedReady();
				return cdJson(ok ? 200 : 503, {
					...service.health(),
					ok,
					readiness,
					simulated: config.simulate,
					refusals,
				});
			}
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
