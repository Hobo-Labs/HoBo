import { fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
	EPHEMERAL_STATE_MAX_TTL_MS,
	type EphemeralKey,
	type EphemeralTtlMs,
	parseEphemeralKey,
	parseEphemeralTtlMs,
} from "@hobo/core";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const RELAY_JOB_QUEUE_LIMIT_MS = 24 * HOUR;
export const RELAY_TTL_MARGIN_MS = HOUR;
export const RELAY_TERMINAL_TTL_MS = 24 * HOUR;
export const RELAY_DELIVERY_TTL_MS = 24 * HOUR;
export const RELAY_FEED_CAPACITY = 500;
export const RELAY_FEED_TTL_MS = HOUR;
export const RELAY_PENDING_TTL_MS =
	RELAY_JOB_QUEUE_LIMIT_MS + RELAY_TTL_MARGIN_MS;
export const RELAY_MAX_PENDING = 2000;
export const RELAY_MAX_RECENT_TERMINAL = 50;
export const RELAY_PHANTOM_ENTRY_GRACE_MS = 2 * MINUTE;
export const RELAY_PROXY_RATE_WINDOW_MS = MINUTE;
export const RELAY_PROXY_RATE_LIMIT = 600;
export const RELAY_WEBHOOK_RATE_WINDOW_MS = MINUTE;

function ttl(ms: number): EphemeralTtlMs {
	return parseEphemeralTtlMs(
		Math.min(Math.ceil(ms), EPHEMERAL_STATE_MAX_TTL_MS),
	);
}

export function relayLeaseTtl(lease: {
	reservedMinutes: number;
	sandboxPricing?:
		| { proxyVmRequired: boolean; proxyVmExtraMs: number }
		| undefined;
}): EphemeralTtlMs {
	const runMs =
		Math.max(0, lease.reservedMinutes) * MINUTE +
		(lease.sandboxPricing?.proxyVmRequired
			? Math.max(0, lease.sandboxPricing.proxyVmExtraMs)
			: 0);
	return ttl(Math.max(RELAY_JOB_QUEUE_LIMIT_MS, runMs) + RELAY_TTL_MARGIN_MS);
}

export function relaySandboxCounterTtl(lease: {
	reservedMinutes: number;
	sandboxPricing?:
		| { proxyVmRequired: boolean; proxyVmExtraMs: number }
		| undefined;
}): EphemeralTtlMs {
	const runMs =
		Math.max(0, lease.reservedMinutes) * MINUTE +
		(lease.sandboxPricing?.proxyVmRequired
			? Math.max(0, lease.sandboxPricing.proxyVmExtraMs)
			: 0);
	return ttl(runMs + RELAY_TTL_MARGIN_MS);
}

export const RELAY_SCAN_LOCK_TTL_MS = 5 * MINUTE;
export const RELAY_WEBHOOK_CURSOR_TTL_MS = 3 * 24 * HOUR;
export const RELAY_WEBHOOK_CLAIM_TTL_MS = 15 * MINUTE;
export const RELAY_WEBHOOK_SUCCESS_TTL_MS = 4 * 24 * HOUR;
export const RELAY_WEBHOOK_REDELIVERIES_PER_MINUTE = 20;
export const RELAY_QUEUED_API_PER_MINUTE = 10;
export const RELAY_QUEUED_SCAN_TTL_MS = 24 * HOUR;
export const RELAY_VERIFIED_INSTALLATION_TTL_MS = 24 * HOUR;
export const RELAY_WORKER_HEALTH_TTL_MS = 24 * HOUR;

export const RELAY_TTL = Object.freeze({
	terminal: ttl(RELAY_TERMINAL_TTL_MS),
	delivery: ttl(RELAY_DELIVERY_TTL_MS),
	pending: ttl(RELAY_PENDING_TTL_MS),
	feed: ttl(RELAY_FEED_TTL_MS),
	jobPending: ttl(RELAY_JOB_QUEUE_LIMIT_MS + RELAY_TTL_MARGIN_MS),
	proxyRate: ttl(RELAY_PROXY_RATE_WINDOW_MS),
	webhookRate: ttl(RELAY_WEBHOOK_RATE_WINDOW_MS),
	scanLock: ttl(RELAY_SCAN_LOCK_TTL_MS),
	webhookCursor: ttl(RELAY_WEBHOOK_CURSOR_TTL_MS),
	webhookClaim: ttl(RELAY_WEBHOOK_CLAIM_TTL_MS),
	webhookSuccess: ttl(RELAY_WEBHOOK_SUCCESS_TTL_MS),
	minuteWindow: ttl(MINUTE),
	queuedScan: ttl(RELAY_QUEUED_SCAN_TTL_MS),
	verifiedInstallations: ttl(RELAY_VERIFIED_INSTALLATION_TTL_MS),
	workerHealth: ttl(RELAY_WORKER_HEALTH_TTL_MS),
});

export function relayTtlUntil(
	expiresAtMs: number,
	nowMs: number,
): EphemeralTtlMs {
	return ttl(Math.max(1000, expiresAtMs - nowMs));
}

const SEGMENT = /^[\x21-\x7e]{1,200}$/u;
function segment(value: string, name: string): string {
	if (!SEGMENT.test(value) || value.includes("{") || value.includes("}"))
		throw new Error(`invalid ${name} for a cache key`);
	return value;
}

export function relayCacheKeys(environment: string) {
	const prefix = `hobo-ci:${segment(environment, "environment")}:`;
	const key = (rest: string): EphemeralKey => parseEphemeralKey(prefix + rest);
	return {
		prefix,
		lease: (leaseId: string) => key(`lease:${segment(leaseId, "lease id")}`),
		job: (jobKey: string) => key(`job:${segment(jobKey, "job key")}`),
		inflight: (accountId: string) =>
			key(`inflight:${segment(accountId, "account id")}`),
		pending: () => key("pending"),
		delivery: (deliveryId: string) =>
			key(`delivery:${segment(deliveryId, "delivery id")}`),
		deliveryBody: (installationId: number, bodySha256: string) =>
			key(
				`delivery-body:${installationId}:${segment(bodySha256, "body hash")}`,
			),
		webhookRate: (installationId: number, windowStart: number) =>
			key(`webhook-rate:${installationId}:${windowStart}`),
		sandboxEgress: (sandboxId: string) =>
			key(`sbx:egress:${segment(sandboxId, "sandbox id")}`),
		sandboxEgressUsed: (sandboxId: string) =>
			key(`sbx:egress-used:${segment(sandboxId, "sandbox id")}`),
		proxyCalls: (leaseId: string) =>
			key(`sbx:proxy-calls:${segment(leaseId, "lease id")}`),
		proxyRequests: (leaseId: string) =>
			key(`sbx:proxy-requests:${segment(leaseId, "lease id")}`),
		proxyRate: (leaseId: string, windowStart: number) =>
			key(`sbx:proxy-rate:${segment(leaseId, "lease id")}:${windowStart}`),
		proxyRequest: (leaseId: string, requestId: string) =>
			key(
				`sbx:proxy-req:${segment(leaseId, "lease id")}:${segment(requestId, "request id")}`,
			),
		proxyMeter: (leaseId: string) =>
			key(`sbx:proxy-meter:${segment(leaseId, "lease id")}`),
		repairLock: (scanner: "webhook" | "queued", appId: string) =>
			key(`repair:${scanner}:${segment(appId, "App id")}:lock`),
		webhookCursor: (appId: string) =>
			key(`repair:webhook:${segment(appId, "App id")}:cursor`),
		webhookClaim: (appId: string, guid: string) =>
			key(
				`repair:webhook:${segment(appId, "App id")}:claim:${segment(guid, "delivery guid")}`,
			),
		webhookSuccess: (appId: string, guid: string) =>
			key(
				`repair:webhook:${segment(appId, "App id")}:ok:${segment(guid, "delivery guid")}`,
			),
		webhookRedeliveries: (appId: string, windowStart: number) =>
			key(`repair:webhook:${segment(appId, "App id")}:rate:${windowStart}`),
		queuedScan: (appId: string, scanKey: string) =>
			key(
				`repair:queued:${segment(appId, "App id")}:scan:${segment(scanKey, "scan key")}`,
			),
		queuedBudget: (appId: string, windowStart: number) =>
			key(`repair:queued:${segment(appId, "App id")}:budget:${windowStart}`),
		sealed: (
			kind:
				| "oauth-state"
				| "oauth-session"
				| "app-state"
				| "owner-session"
				| "invitation",
			mac: string,
		) => key(`${kind}:${segment(mac, "record mac")}`),
		verifiedInstallations: (accountId: string) =>
			key(`app:installations:${segment(accountId, "account id")}`),
		installationOwner: (installationId: number) =>
			key(`app:installation-owner:${installationId}`),
		workerHealth: (scope: string, component: string) =>
			key(
				`worker-health:${segment(scope, "health scope")}:${segment(component, "component")}`,
			),
		fleetVerdict: (repository: string, reporterId: string) =>
			key(
				`fleet-verdict:${segment(repository, "repository")}:${segment(reporterId, "reporter id")}`,
			),
		fleetReporter: (repository: string, reporterId: string) =>
			key(
				`fleet-reporter:${segment(repository, "repository")}:${segment(reporterId, "reporter id")}`,
			),
		fleetAllowance: (repository: string) =>
			key(`fleet-allowance:${segment(repository, "repository")}`),
		feedRing: (accountId: string) =>
			`${prefix}feed:${segment(accountId, "account id")}`,
	} as const;
}
export type RelayCacheKeys = ReturnType<typeof relayCacheKeys>;

export const decodeRecord = fromJsonString;
export const encodeRecord = toJsonString;
