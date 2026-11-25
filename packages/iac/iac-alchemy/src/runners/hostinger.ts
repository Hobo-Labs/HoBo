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

// public-contract: pinned Hostinger API origin fleet transports allowlist against.
export const HOSTINGER_PINNED_API_ORIGIN = "https://developers.hostinger.com";
const HOSTINGER_API_HOST = "developers.hostinger.com";
const HOSTINGER_VIRTUAL_MACHINES_PATH = "/api/vps/v1/virtual-machines";
const HOSTINGER_MACHINE_ID = /^[1-9][0-9]{0,18}$/u;
const HOSTINGER_POWER_ACTIONS = ["start", "restart", "stop"] as const;
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
		| "HOSTINGER_TRANSPORT_FAILED"
		| "HOSTINGER_CONCURRENCY_EXCEEDED";
	readonly message: string;
}> {}

export interface HostingerRunnerRegistry {
	readonly registerSlot: (input: {
		readonly machineId: string;
		readonly jobId: string;
		readonly labels: readonly string[];
		readonly maxConcurrency: number;
	}) => Promise<{ readonly runnerId: string; readonly shouldPowerOn: boolean }>;
	readonly releaseSlot: (
		runnerId: string,
	) => Promise<{ readonly remainingOnMachine: number }>;
}

export function createInMemoryHostingerRunnerRegistry(): HostingerRunnerRegistry & {
	readonly activeRunnerIds: () => readonly string[];
} {
	const active = new Map<string, string>();
	const slotsByMachine = new Map<string, Set<string>>();
	return {
		async registerSlot(input) {
			const slots =
				slotsByMachine.get(input.machineId) ?? new Set<string>();
			if (slots.size >= input.maxConcurrency) {
				throw new HostingerRunnerError({
					code: "HOSTINGER_CONCURRENCY_EXCEEDED",
					message: `hostinger runner pool ${input.machineId} exceeded maxConcurrency ${input.maxConcurrency}`,
				});
			}
			const shouldPowerOn = slots.size === 0;
			const runnerId = `hostinger:${input.jobId}:${input.machineId}`;
			active.set(runnerId, input.machineId);
			slots.add(runnerId);
			slotsByMachine.set(input.machineId, slots);
			return { runnerId, shouldPowerOn };
		},
		async releaseSlot(runnerId) {
			const machineId = active.get(runnerId);
			active.delete(runnerId);
			if (machineId === undefined) {
				return { remainingOnMachine: 0 };
			}
			const slots = slotsByMachine.get(machineId);
			slots?.delete(runnerId);
			const remainingOnMachine = slots?.size ?? 0;
			if (remainingOnMachine === 0) {
				slotsByMachine.delete(machineId);
			}
			return { remainingOnMachine };
		},
		activeRunnerIds() {
			return [...active.keys()].sort();
		},
	};
}

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
	readonly jobId: string;
	readonly machineId: string;
	readonly hostname: string;
	readonly labels: readonly string[];
	readonly maxConcurrency: number;
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
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:") return false;
	if (parsed.username.length > 0 || parsed.password.length > 0) return false;
	if (parsed.host !== HOSTINGER_API_HOST) return false;
	const path = parsed.pathname;
	if (method === "GET") return path === HOSTINGER_VIRTUAL_MACHINES_PATH;
	return method === "POST" && HOSTINGER_POWER_ROUTE.test(path);
}

export function resolveHostingerFleetUrl(path: string): string {
	const suffix = path.startsWith("/") ? path : `/${path}`;
	return `${HOSTINGER_PINNED_API_ORIGIN}${suffix}`;
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
	readonly registry: HostingerRunnerRegistry;
	readonly defaultApiOrigin?: string;
}

export function HostingerRunnerProvider(
	options: HostingerRunnerProviderOptions,
) {
	const guarded = guardedHostingerRunnerTransport(options.transport);
	const configuredOrigin = options.defaultApiOrigin;
	if (
		configuredOrigin !== undefined &&
		configuredOrigin !== HOSTINGER_PINNED_API_ORIGIN
	) {
		throw new HostingerRunnerError({
			code: "HOSTINGER_ROUTE_REFUSED",
			message: `hostinger runner api origin must be ${HOSTINGER_PINNED_API_ORIGIN}`,
		});
	}

	return Provider.succeed(HostingerRunner, {
		reconcile: ({ news, output }) =>
			Effect.gen(function* () {
				if (!HOSTINGER_MACHINE_ID.test(news.machineId)) {
					return yield* new HostingerRunnerError({
						code: "HOSTINGER_MACHINE_INVALID",
						message: `invalid Hostinger machine id: ${news.machineId}`,
					});
				}
				if (news.maxConcurrency < 1) {
					return yield* new HostingerRunnerError({
						code: "HOSTINGER_MACHINE_INVALID",
						message:
							"hostinger runner requires maxConcurrency >= 1",
					});
				}
				if (
					news.apiOrigin !== undefined &&
					news.apiOrigin !== HOSTINGER_PINNED_API_ORIGIN
				) {
					return yield* new HostingerRunnerError({
						code: "HOSTINGER_ROUTE_REFUSED",
						message: `hostinger runner api origin must be ${HOSTINGER_PINNED_API_ORIGIN}`,
					});
				}
				const locator = parseOwnerCredentialLocator(news.credentialLocator);
				const credential = yield* resolveOwnerCredential(
					options.resolveCredential,
					locator,
				);
				const runnerId = `hostinger:${news.jobId}:${news.machineId}`;
				if (
					output !== undefined &&
					output.runnerId === runnerId &&
					output.machineId === news.machineId
				) {
					return {
						runnerId,
						tier: "hostinger" as const,
						machineId: news.machineId,
						hostname: output.hostname,
						labels: [...news.labels],
						state: output.state,
						actionId: output.actionId,
						credentialLocator: locator,
					};
				}
				const registered = yield* Effect.tryPromise({
					try: () =>
						options.registry.registerSlot({
							machineId: news.machineId,
							jobId: news.jobId,
							labels: news.labels,
							maxConcurrency: news.maxConcurrency,
						}),
					catch: (cause): HostingerRunnerError | RunnerCredentialError =>
						cause instanceof HostingerRunnerError
							? cause
							: new HostingerRunnerError({
									code: "HOSTINGER_TRANSPORT_FAILED",
									message:
										cause instanceof Error
											? cause.message
											: "hostinger runner registration failed",
								}),
				});
				const registeredRunnerId = registered.runnerId;
				if (!registered.shouldPowerOn) {
					return {
						runnerId: registeredRunnerId,
						tier: "hostinger" as const,
						machineId: news.machineId,
						hostname: news.hostname,
						labels: [...news.labels],
						state: "running",
						actionId: `${news.machineId}:shared`,
						credentialLocator: locator,
					};
				}
				const action = news.powerAction ?? "start";
				const url = resolveHostingerFleetUrl(
					`${HOSTINGER_VIRTUAL_MACHINES_PATH}/${news.machineId}/${action}`,
				);
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
					runnerId: registeredRunnerId,
					tier: "hostinger" as const,
					machineId: news.machineId,
					hostname: response.body.hostname ?? news.hostname,
					labels: [...news.labels],
					state: response.body.state ?? "running",
					actionId: response.body.actionId ?? `${news.machineId}:${action}`,
					credentialLocator: locator,
				};
			}),
		delete: ({ output, olds }) =>
			Effect.gen(function* () {
				if (output === undefined) return;
				const released = yield* Effect.tryPromise({
					try: () => options.registry.releaseSlot(output.runnerId),
					catch: (cause): HostingerRunnerError =>
						cause instanceof HostingerRunnerError
							? cause
							: new HostingerRunnerError({
									code: "HOSTINGER_TRANSPORT_FAILED",
									message:
										cause instanceof Error
											? cause.message
											: "hostinger runner release failed",
								}),
				});
				if (released.remainingOnMachine > 0) return;
				const locator = parseOwnerCredentialLocator(
					olds?.credentialLocator ?? output.credentialLocator,
				);
				const credential = yield* resolveOwnerCredential(
					options.resolveCredential,
					locator,
				);
				const url = resolveHostingerFleetUrl(
					`${HOSTINGER_VIRTUAL_MACHINES_PATH}/${output.machineId}/stop`,
				);
				yield* Effect.tryPromise({
					try: () =>
						guarded({
							method: "POST",
							url,
							headers: {
								authorization: `Bearer ${credential}`,
								accept: "application/json",
							},
						}),
					catch: () => undefined,
				}).pipe(Effect.ignore);
			}),
	});
}
