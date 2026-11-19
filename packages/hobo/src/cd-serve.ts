import { type CampId, CampManagement } from "@hobo/cd";
import { defaultRetention } from "@hobo/cd/compose";
import { createCdControlApi, createCdService } from "@hobo/cd/service";
import {
	type CdListenerAccess,
	sanitizedCdHealth,
	startCdListener,
} from "./cd-listener.js";
import type { CdRuntime } from "./cd-runtime.js";

export type { CdListenerAccess, CdOperatorRequest } from "./cd-listener.js";

export type CdServer = Readonly<{
	url: string;
	port: number;
	reconcilers: number;
	refusals: readonly string[];
	close(signal?: AbortSignal): Promise<void>;
}>;

export async function startCdServer(
	input: Readonly<{
		runtime: CdRuntime;
		host: string;
		port: number;
		log: (line: string) => void;
		access?: CdListenerAccess;
	}>,
): Promise<CdServer> {
	const { runtime } = input;
	try {
		const { cd, config } = runtime;
		const refusals: string[] = [];
		const managed: CampId[] = (await cd.topology.camps())
			.filter((camp) => camp.management !== CampManagement.OBSERVE_ONLY)
			.map((camp) => camp.campId);
		const reconcilers = [];
		if (managed.length > 0) {
			try {
				reconcilers.push(
					runtime.conductor(managed, `hobo-serve-cd:${process.pid}`),
				);
			} catch {
				refusals.push("conductor-unavailable");
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
			principal: { kind: "service", id: `hobo-serve-cd:${config.stationId}` },
			telemetry: cd.sink,
		});
		const issuerReady = () => {
			try {
				return (
					input.access?.kind !== "authenticated" ||
					runtime.issuerReady?.() === true
				);
			} catch {
				return false;
			}
		};
		const api = createCdControlApi({
			store: runtime.store,
			tenant: config.tenant,
			now: runtime.ctx.now,
			cd,
			topology: cd.topology,
			service: {
				health: () => {
					const health = sanitizedCdHealth(service.health());
					const checks = [...health.checks];
					if (refusals.length > 0)
						checks.push({
							name: "conductor",
							ok: false,
							detail: "conductor could not be composed",
						});
					const signingReady = issuerReady();
					if (!signingReady)
						checks.push({
							name: "issuer",
							ok: false,
							detail: "signing key unavailable",
						});
					return {
						ok: health.ok && refusals.length === 0 && signingReady,
						checks,
					};
				},
			},
			telemetry: cd.sink,
		});
		const listener = await startCdListener({
			host: input.host,
			port: input.port,
			access: input.access ?? { kind: "loopback" },
			...(runtime.publicOrigin === undefined
				? undefined
				: { runtimeOrigin: runtime.publicOrigin }),
			...(runtime.issuerKeyId === undefined
				? undefined
				: { issuerKeyId: runtime.issuerKeyId }),
			service: { ...service, ready: () => service.ready() && issuerReady() },
			api,
			simulated: config.simulate,
			refusals,
		});
		try {
			input.log(
				`hobo serve cd: listening (store=${config.store.backend}${config.simulate ? " SIMULATED" : ""}) reconcilers=${reconcilers.length}${refusals.length > 0 ? ` refused=${refusals.length}` : ""}`,
			);
		} catch (error) {
			await listener.close().catch(() => {});
			throw error;
		}
		let closing: Promise<void> | undefined;
		return Object.freeze({
			url: listener.url,
			port: listener.port,
			reconcilers: reconcilers.length,
			refusals,
			close(signal?: AbortSignal) {
				closing ??= (async () => {
					try {
						await listener.close(signal);
					} finally {
						await runtime.close();
					}
				})();
				return closing;
			},
		});
	} catch (error) {
		await runtime.close();
		throw error;
	}
}
