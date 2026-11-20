/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: the HTTP edge: a response body is any JSON the service reports, only stringified, and refusal codes are decoded from error values at this boundary. */

import {
	type CampId,
	CampManagement,
	type CampReconciler,
	type FeedRequest,
	type FeedResponse,
} from "@hobo/cd";
import { defaultRetention } from "@hobo/cd/compose";
import { asCamp } from "@hobo/cd/rollout";
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
// public-contract: durable readiness record every holder appends after a fully successful pass; /readyz reads it back instead of any process-local latch. The durable stream is tenant-scoped: `${tenant}:${HOST_PASS_STREAM}`.
export const HOST_PASS_STREAM = "cd-host-pass";
// public-contract: event type every holder appends to HOST_PASS_STREAM after a successful pass.
export const HOST_PASS_SUCCEEDED = "host.PassSucceeded";
// public-contract: refusal code recorded when the topology declares Camps but none are MANAGED.
export const CD_NO_MANAGED_CAMPS = "cd-no-managed-camps";
// public-contract: how many tail events of the readiness stream /readyz folds; the latest host.PassSucceeded among them wins.
const HOST_PASS_LOOKBACK = 8;
const HOST_PASS_FUTURE_SKEW_MS = 5_000;

export class CdHostPassRecordError extends Error {
	readonly code = "cd-host-pass-record-failed";
	constructor(message: string) {
		super(message);
		this.name = "CdHostPassRecordError";
	}
}

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

const LEASE_CONFLICT_CODES: ReadonlySet<string> = new Set([
	"STALE_FENCE",
	"LEASE_CONFLICT",
	"SUBSCRIPTION_LEASE_CONFLICT",
]);

function isLeaseConflict<T>(error: T): boolean {
	if (error instanceof EventStoreError)
		return LEASE_CONFLICT_CODES.has(error.code);
	return (
		error instanceof Error &&
		"code" in error &&
		isString(error.code) &&
		LEASE_CONFLICT_CODES.has(error.code)
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

function passSucceededCampIds(data: unknown): readonly CampId[] | undefined {
	if (data === null || typeof data !== "object") return undefined;
	for (const [key, value] of Object.entries(data)) {
		if (key !== "campIds") continue;
		if (!Array.isArray(value)) return undefined;
		const ids: CampId[] = [];
		for (const entry of value) {
			if (typeof entry !== "string" || entry.length === 0) return undefined;
			ids.push(asCamp(entry));
		}
		return ids;
	}
	return undefined;
}

function campIdsMatchManaged(
	recorded: readonly CampId[],
	expected: readonly CampId[],
): boolean {
	if (recorded.length !== expected.length) return false;
	const left = [...recorded].sort();
	const right = [...expected].sort();
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
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
	const hostPassStream = `${config.tenant}:${HOST_PASS_STREAM}`;
	const readiness = input.readiness ?? "service";
	const storeHealthy = () =>
		service.health().checks.some((check) => check.name === "store" && check.ok);
	const serviceReady = () => refusals.length === 0 && service.ready();

	async function hostPassRevision(): Promise<number> {
		const head = runtime.store.getStreamHead?.(hostPassStream);
		if (head !== undefined) return head.revision;
		let revision = 0;
		for await (const event of runtime.store.read(hostPassStream))
			revision = event.seq;
		return revision;
	}

	async function recordSuccessfulPass(
		campIds: readonly CampId[],
		allowRecord: () => boolean,
	): Promise<void> {
		if (!allowRecord()) return;
		const atMs = runtime.ctx.now();
		const event = {
			type: HOST_PASS_SUCCEEDED,
			data: { atMs, campIds: [...campIds] },
			meta: { idempotencyKey: `host-pass:${input.holderId}:${atMs}` },
		};
		let lastError: unknown;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (!allowRecord()) return;
			try {
				const expectedSeq = await hostPassRevision();
				if (!allowRecord()) return;
				await runtime.store.append(hostPassStream, [event], {
					expectedSeq,
					actor: servicePrincipal,
					tenant: config.tenant,
				});
				return;
			} catch (error) {
				lastError = error;
			}
		}
		throw new CdHostPassRecordError(
			`the successful pass could not be recorded on ${hostPassStream}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
		);
	}

	async function lastSuccessfulPassAtMs(): Promise<number | undefined> {
		try {
			const head = runtime.store.getStreamHead?.(hostPassStream);
			const tail =
				head !== undefined ? head.revision : await hostPassRevision();
			const fromSeq = Math.max(1, tail - (HOST_PASS_LOOKBACK - 1));
			const now = runtime.ctx.now();
			let atMs: number | undefined;
			for await (const event of runtime.store.read(hostPassStream, fromSeq)) {
				if (event.type !== HOST_PASS_SUCCEEDED) continue;
				const stored = Date.parse(event.ts);
				const candidate = Number.isNaN(stored)
					? passSucceededAtMs(event.data)
					: stored;
				if (candidate === undefined) continue;
				if (candidate - now > HOST_PASS_FUTURE_SKEW_MS) continue;
				const campIds = passSucceededCampIds(event.data);
				if (campIds === undefined) continue;
				if (!campIdsMatchManaged(campIds, managed)) continue;
				atMs = candidate;
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
		const ageMs = runtime.ctx.now() - passedAtMs;
		return ageMs >= -HOST_PASS_FUTURE_SKEW_MS && ageMs <= passRecordMaxAgeMs;
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

	async function runPass(
		signal: AbortSignal,
		allowRecord: () => boolean,
	): Promise<CdPassReport> {
		if (signal.aborted) throw abortErrorOf(signal);
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
			if (signal.aborted) throw abortErrorOf(signal);
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
			const reconcilesOk =
				refusals.length === 0 &&
				managed.length > 0 &&
				reconciled.length === managed.length &&
				reconciled.every((entry) => entry.ok);
			const tick = reconcilesOk ? await service.tick() : undefined;
			if (signal.aborted) throw abortErrorOf(signal);
			const passCounts = reconcilesOk && tick?.store;
			if (passCounts && allowRecord()) {
				if (signal.aborted) throw abortErrorOf(signal);
				await recordSuccessfulPass(managed, allowRecord);
			}
			return Object.freeze({
				tick:
					tick ??
					Object.freeze({
						atMs: runtime.ctx.now(),
						store: storeHealthy(),
						steps: Object.freeze([]),
					}),
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
		const deadline = AbortSignal.timeout(passDeadlineMs);
		const signal =
			external === undefined ? deadline : AbortSignal.any([deadline, external]);
		const deadlineMessage = `cd pass deadline exceeded after ${passDeadlineMs} ms`;
		const deadlineRejection = new Promise<never>((_, reject) => {
			const onDeadline = () => {
				reject(new Error(deadlineMessage));
			};
			if (deadline.aborted) onDeadline();
			else deadline.addEventListener("abort", onDeadline, { once: true });
		});
		void deadlineRejection.catch(() => undefined);
		let onExternalAbort: (() => void) | undefined;
		const abortRejection =
			external === undefined
				? undefined
				: new Promise<never>((_, reject) => {
						onExternalAbort = () => reject(abortErrorOf(external));
						if (external.aborted) onExternalAbort();
						else
							external.addEventListener("abort", onExternalAbort, {
								once: true,
							});
					});
		let recordPassOutcome = true;
		const suppressRecord = () => {
			recordPassOutcome = false;
		};
		deadline.addEventListener("abort", suppressRecord, { once: true });
		if (external !== undefined)
			external.addEventListener("abort", suppressRecord, { once: true });
		const running = runPass(signal, () => recordPassOutcome);
		void running.catch(() => undefined);
		const racers: Promise<CdPassReport>[] = [running, deadlineRejection];
		if (abortRejection !== undefined) racers.push(abortRejection);
		const bounded = (async (): Promise<CdPassReport> => {
			try {
				return await Promise.race(racers);
			} catch (error) {
				if (deadline.aborted) recordPassOutcome = false;
				throw error;
			} finally {
				if (onExternalAbort !== undefined)
					external?.removeEventListener("abort", onExternalAbort);
			}
		})();
		inFlightPass = bounded;
		const release = () => {
			if (inFlightPass === bounded) inFlightPass = undefined;
		};
		void bounded.then(release, release);
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
