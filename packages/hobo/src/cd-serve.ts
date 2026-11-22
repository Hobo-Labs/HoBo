import { randomUUID } from "node:crypto";
import { composeCdHost } from "./cd-host.js";
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
		const { config } = runtime;
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
		let refused: readonly string[] = [];
		let host: Awaited<ReturnType<typeof composeCdHost>>;
		try {
			host = await composeCdHost({
				runtime,
				holderId: `hobo-serve-cd:${config.stationId}:${randomUUID()}`,
				principalId: `hobo-serve-cd:${config.stationId}`,
				fleetPassLease: true,
				health: (report) => {
					const health = sanitizedCdHealth(report);
					const checks = [...health.checks];
					if (refused.length > 0)
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
						ok: health.ok && refused.length === 0 && signingReady,
						checks,
					};
				},
			});
		} catch {
			throw new Error("The CD service topology could not be read.");
		}
		const { service, refusals } = host;
		refused = refusals;
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
			api: {
				pathPrefix: host.pathPrefix,
				handle: (request, signal) => host.handle(request, signal),
			},
			simulated: config.simulate,
			refusals,
		});
		try {
			input.log(
				`hobo serve cd: listening (store=${config.store.backend}${config.simulate ? " SIMULATED" : ""}) reconcilers=${host.reconcilers}${refusals.length > 0 ? ` refused=${refusals.length}` : ""}`,
			);
		} catch (error) {
			await listener.close().catch(() => {});
			throw error;
		}
		let closing: Promise<void> | undefined;
		return Object.freeze({
			url: listener.url,
			port: listener.port,
			reconcilers: host.reconcilers,
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
