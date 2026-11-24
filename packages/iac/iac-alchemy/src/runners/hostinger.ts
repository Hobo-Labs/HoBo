import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
	type OwnerCredentialResolver,
	parseOwnerCredentialLocator,
	type RunnerCredentialError,
	resolveOwnerCredential,
} from "./owner-credentials.js";

const HOSTINGER_VIRTUAL_MACHINES_PATH = "/api/vps/v1/virtual-machines";
const HOSTINGER_MACHINE_ID = /^[1-9][0-9]{0,18}$/u;
const HOSTINGER_POWER_ACTIONS = ["start", "restart"] as const;
export type HostingerRunnerPowerAction =
	(typeof HOSTINGER_POWER_ACTIONS)[number];

const HOSTINGER_POWER_ROUTE = new RegExp(
	`^${HOSTINGER_VIRTUAL_MACHINES_PATH}/[1-9][0-9]{0,18}/(?:${HOSTINGER_POWER_ACTIONS.join("|")})$`,
	"u",
);

export class HostingerRunnerError extends Data.TaggedError(
	"HostingerRunnerError",
)<{
	readonly code:
		| "HOSTINGER_ROUTE_REFUSED"
		| "HOSTINGER_MACHINE_INVALID"
		| "HOSTINGER_TRANSPORT_FAILED";
	readonly message: string;
}> {}

export interface HostingerRunnerTransportRequest {
	readonly method: "GET" | "POST";
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
}

export interface HostingerRunnerTransportResponse {
	readonly status: number;
	readonly body: {
		readonly id?: string;
		readonly state?: string;
		readonly hostname?: string;
		readonly actionId?: string;
	};
}

export type HostingerRunnerTransport = (
	request: HostingerRunnerTransportRequest,
) => Promise<HostingerRunnerTransportResponse>;

export interface HostingerRunnerProps {
	readonly machineId: string;
	readonly hostname: string;
	readonly labels: readonly string[];
	readonly powerAction?: HostingerRunnerPowerAction;
	readonly credentialLocator: string;
	readonly apiOrigin?: string;
}

export interface HostingerRunnerAttr {
	readonly runnerId: string;
	readonly tier: "hostinger";
	readonly machineId: string;
	readonly hostname: string;
	readonly labels: readonly string[];
	readonly state: string;
	readonly actionId: string;
	readonly credentialLocator: string;
}

export type HostingerRunner = Resource<
	"Hobo.HostingerRunner",
	HostingerRunnerProps,
	HostingerRunnerAttr
>;

export const HostingerRunner = Resource<HostingerRunner>(
	"Hobo.HostingerRunner",
);

export function isAllowedHostingerFleetRoute(
	method: "GET" | "POST",
	url: string,
): boolean {
	try {
		const path = new URL(url).pathname;
		if (method === "GET") return path === HOSTINGER_VIRTUAL_MACHINES_PATH;
		return method === "POST" && HOSTINGER_POWER_ROUTE.test(path);
	} catch {
		return false;
	}
}

export function guardedHostingerRunnerTransport(
	inner: HostingerRunnerTransport,
): HostingerRunnerTransport {
	return async (request) => {
		if (!isAllowedHostingerFleetRoute(request.method, request.url)) {
			throw new HostingerRunnerError({
				code: "HOSTINGER_ROUTE_REFUSED",
				message: `hostinger runner route refused: ${request.method} ${request.url}`,
			});
		}
		return inner(request);
	};
}

export interface HostingerRunnerProviderOptions {
	readonly resolveCredential: OwnerCredentialResolver;
	readonly transport: HostingerRunnerTransport;
	readonly defaultApiOrigin?: string;
}

export function HostingerRunnerProvider(
	options: HostingerRunnerProviderOptions,
) {
	const guarded = guardedHostingerRunnerTransport(options.transport);
	const defaultOrigin =
		options.defaultApiOrigin ?? "https://developers.hostinger.com";

	return Provider.succeed(HostingerRunner, {
		reconcile: ({ news }) =>
			Effect.gen(function* () {
				if (!HOSTINGER_MACHINE_ID.test(news.machineId)) {
					return yield* new HostingerRunnerError({
						code: "HOSTINGER_MACHINE_INVALID",
						message: `invalid Hostinger machine id: ${news.machineId}`,
					});
				}
				const locator = parseOwnerCredentialLocator(news.credentialLocator);
				const credential = yield* resolveOwnerCredential(
					options.resolveCredential,
					locator,
				);
				const action = news.powerAction ?? "start";
				const origin = news.apiOrigin ?? defaultOrigin;
				const url = `${origin}${HOSTINGER_VIRTUAL_MACHINES_PATH}/${news.machineId}/${action}`;
				const response = yield* Effect.tryPromise({
					try: () =>
						guarded({
							method: "POST",
							url,
							headers: {
								authorization: `Bearer ${credential}`,
								accept: "application/json",
							},
						}),
					catch: (cause): HostingerRunnerError | RunnerCredentialError =>
						cause instanceof HostingerRunnerError
							? cause
							: new HostingerRunnerError({
									code: "HOSTINGER_TRANSPORT_FAILED",
									message:
										cause instanceof Error
											? cause.message
											: "hostinger runner reconcile failed",
								}),
				});
				if (response.status < 200 || response.status >= 300) {
					return yield* new HostingerRunnerError({
						code: "HOSTINGER_TRANSPORT_FAILED",
						message: `hostinger runner returned status ${response.status}`,
					});
				}
				return {
					runnerId: `hostinger:${news.machineId}`,
					tier: "hostinger" as const,
					machineId: news.machineId,
					hostname: response.body.hostname ?? news.hostname,
					labels: [...news.labels],
					state: response.body.state ?? "running",
					actionId: response.body.actionId ?? `${news.machineId}:${action}`,
					credentialLocator: locator,
				};
			}),
		delete: () => Effect.void,
	});
}
