/**
 * The CD conductor service over an opened CD runtime, without a server: the
 * one HTTP mount (`/healthz`, `/readyz`, `/v1/cd/`) as a request handler, and
 * one bounded pass as a function. `hobo serve cd` runs it behind `node:http`
 * with the service's own tick loop (`cd-serve.ts`); a platform function
 * (`packages/cd-vercel`) calls `handle` per request and `pass` per schedule.
 */

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
import type { CdRuntime } from "./cd-runtime.js";

/** A JSON response on the CD mount. */
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

/** What `/readyz` says, beyond the service's own health. */
export type CdReadiness = "service" | "composed";

export type CdHost = Readonly<{
	service: CdServiceHost;
	/** The Camps this host converges (all but OBSERVE_ONLY). */
	managed: readonly CampId[];
	reconcilers: number;
	refusals: readonly string[];
	pathPrefix: string;
	/** Answer one request on the mount. */
	handle(request: FeedRequest, signal: AbortSignal): Promise<FeedResponse>;
	/**
	 * One bounded pass: each managed Camp reconciled once, then one service
	 * tick (sources → … → retention). For a host without a tick loop.
	 */
	pass(): Promise<
		Readonly<{
			tick: TickReport;
			reconciled: readonly Readonly<{
				campId: CampId;
				ok: boolean;
				detail: string;
			}>[];
		}>
	>;
}>;

/** Compose the conductor service, its read API and the feed. */
export async function composeCdHost(
	input: Readonly<{
		runtime: CdRuntime;
		/** Names the conductor's lease holder. */
		holderId: string;
		/** The service's principal id (default: the holder id). */
		principalId?: string;
		/**
		 * `service`: ready when the service says so (its tick loop runs).
		 * `composed`: ready when the runtime opened and the conductor was
		 * built; a platform function has no loop, so the service never starts.
		 */
		readiness?: CdReadiness;
	}>,
): Promise<CdHost> {
	const { runtime } = input;
	const { cd, config } = runtime;
	const refusals: string[] = [];
	const managed: CampId[] = (await cd.topology.camps())
		.filter((camp) => camp.management !== CampManagement.OBSERVE_ONLY)
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
	const ready = () =>
		readiness === "service" ? service.ready() : refusals.length === 0;
	return Object.freeze({
		service,
		managed,
		reconcilers: reconcilers.length,
		refusals,
		pathPrefix: api.pathPrefix,
		async handle(request: FeedRequest, signal: AbortSignal) {
			const path = request.path.split("?")[0] ?? "/";
			if (path === "/healthz") return cdJson(200, { ok: true });
			if (path === "/readyz")
				return cdJson(ready() ? 200 : 503, {
					...service.health(),
					readiness,
					simulated: config.simulate,
					refusals,
				});
			if (!path.startsWith(api.pathPrefix))
				return cdJson(404, { ok: false, code: "not-found" });
			return api.handle(request, signal);
		},
		async pass() {
			const reconciled = [];
			const [reconciler] = reconcilers;
			if (reconciler !== undefined)
				for (const campId of managed) {
					try {
						const observed = await reconciler.reconcileOnce(
							campId,
							runtime.ctx,
						);
						reconciled.push({
							campId,
							// A blocked or refused pass says why in its reasons.
							ok: observed.reasons.length === 0,
							detail:
								observed.reasons[0]?.message ?? `status ${observed.status}`,
						});
					} catch (error) {
						reconciled.push({
							campId,
							ok: false,
							detail: error instanceof Error ? error.message : String(error),
						});
					}
				}
			return { tick: await service.tick(), reconciled };
		},
	});
}
