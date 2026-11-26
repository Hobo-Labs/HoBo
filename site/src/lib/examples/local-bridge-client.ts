import {
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../json-inspect.js";

type BridgeGlobal = typeof globalThis & {
	HOBO_EXAMPLES_BRIDGE_URL?: string;
};

function bridgeGlobal(): BridgeGlobal {
	// SAFETY: we only read/write HOBO_EXAMPLES_BRIDGE_URL on globalThis.
	return globalThis as BridgeGlobal;
}

export type BridgeStationHost = {
	readonly url: string;
	revoke(): void;
};

/** Local examples bridge — Docker Compose host for Wasp OpenSaaS (non-browser stations). */

export const LOCAL_BRIDGE_DEFAULT_URL = "http://127.0.0.1:8787";

export type LocalBridgeHealth = {
	readonly ok: boolean;
	readonly docker: boolean;
	readonly composeProject?: string;
	readonly remediation?: string;
};

type MutableLocalBridgeHealth = {
	ok: boolean;
	docker: boolean;
	composeProject?: string;
	remediation?: string;
};

export type LocalBridgeDeployRequest = {
	readonly exampleId: string;
	readonly stationId: string;
	readonly targetId: string;
	/** Wasp webApp from Bindle — ship runs wasp in `root`. */
	readonly bindleWebApp: {
		readonly framework: string;
		readonly root: string;
	};
	/** Optional OCI deps from Bindle (e.g. Postgres) — not HoBo server/client tags. */
	readonly bindleContainers: readonly {
		readonly name: string;
		readonly image: string;
	}[];
};

export type LocalBridgeDeployResult = {
	readonly exampleId: string;
	readonly stationId: string;
	readonly clientUrl: string;
	readonly serverUrl: string;
};

export type LocalBridgeStatus = {
	readonly deployed: boolean;
	readonly exampleId?: string;
	readonly clientUrl?: string;
	readonly serverUrl?: string;
};

export function resolveLocalBridgeBase(
	override = bridgeGlobal().HOBO_EXAMPLES_BRIDGE_URL,
): string {
	const picked =
		isJsonString(override) && override.trim().length > 0
			? override.trim()
			: LOCAL_BRIDGE_DEFAULT_URL;
	return picked.replace(/\/$/u, "");
}

/** Apply `?bridge=` / `data-bridge-url` before probe/deploy (agent regressions). */
export function applyLocalBridgeUrlOverride(raw: string | null | undefined): string {
	const trimmed = raw?.trim();
	if (!trimmed) return resolveLocalBridgeBase();
	const normalized = trimmed.replace(/\/$/u, "");
	bridgeGlobal().HOBO_EXAMPLES_BRIDGE_URL = normalized;
	return normalized;
}

export async function probeLocalBridge(
	baseUrl = resolveLocalBridgeBase(),
): Promise<LocalBridgeHealth> {
	try {
		const response = await fetch(`${baseUrl}/health`, {
			method: "GET",
			signal: AbortSignal.timeout(2_500),
		});
		if (!response.ok) {
			return {
				ok: false,
				docker: false,
				remediation: `Optional local app-ship bridge HTTP ${response.status} at ${baseUrl}. Environment Stations do not need it.`,
			};
		}
		const body: JsonValue = await response.json();
		if (!isJsonObject(body)) {
			return {
				ok: false,
				docker: false,
				remediation: `Optional local app-ship bridge returned non-object JSON at ${baseUrl}.`,
			};
		}
		const health: MutableLocalBridgeHealth = {
			ok: body.ok === true,
			docker: body.docker === true,
		};
		if (isJsonString(body.composeProject)) health.composeProject = body.composeProject;
		if (isJsonString(body.remediation)) health.remediation = body.remediation;
		return health;
	} catch {
		return {
			ok: false,
			docker: false,
			remediation: `Optional local app-ship bridge unreachable at ${baseUrl}. Environment Stations do not need it — only some OpenSaaS app ships do. Station Pool works on the static site alone.`,
		};
	}
}

export type LocalBridgeStationRequest = {
	readonly stationId: string;
	readonly targetId: string;
	readonly yardId: string;
	readonly homeStationId: string;
};

export type LocalBridgeStationResult = {
	readonly stationId: string;
	readonly targetId: string;
	readonly yardId: string;
	readonly endpointUrl: string;
	readonly anonymous: true;
};

export async function provisionStationViaLocalBridge(
	input: LocalBridgeStationRequest,
	baseUrl = resolveLocalBridgeBase(),
): Promise<LocalBridgeStationResult> {
	const response = await fetch(`${baseUrl}/station`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
		signal: AbortSignal.timeout(300_000),
	});
	const parsed: JsonValue = await response.json().catch(() => ({}));
	const body = isJsonObject(parsed) ? parsed : {};
	if (!response.ok) {
		const error = isJsonString(body.error) ? body.error : undefined;
		const remediation = isJsonString(body.remediation) ? body.remediation : undefined;
		const detail = remediation
			? `${error ?? "station provision failed"} — ${remediation}`
			: (error ?? `Local bridge station provision failed (${response.status})`);
		throw new Error(detail);
	}
	if (
		!isJsonString(body.stationId) ||
		!isJsonString(body.targetId) ||
		!isJsonString(body.yardId) ||
		!isJsonString(body.endpointUrl)
	) {
		throw new Error("Local bridge station response missing endpointUrl");
	}
	return {
		stationId: body.stationId,
		targetId: body.targetId,
		yardId: body.yardId,
		endpointUrl: body.endpointUrl,
		anonymous: true,
	};
}

export async function deployViaLocalBridge(
	input: LocalBridgeDeployRequest,
	baseUrl = resolveLocalBridgeBase(),
): Promise<LocalBridgeDeployResult> {
	const response = await fetch(`${baseUrl}/deploy`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
		signal: AbortSignal.timeout(300_000),
	});
	const parsed: JsonValue = await response.json().catch(() => ({}));
	const body = isJsonObject(parsed) ? parsed : {};
	if (!response.ok) {
		const error = isJsonString(body.error) ? body.error : undefined;
		const remediation = isJsonString(body.remediation) ? body.remediation : undefined;
		const detail = remediation
			? `${error ?? "deploy failed"} — ${remediation}`
			: (error ?? `Local bridge deploy failed (${response.status})`);
		throw new Error(detail);
	}
	if (
		!isJsonString(body.clientUrl) ||
		!isJsonString(body.serverUrl) ||
		!isJsonString(body.exampleId) ||
		!isJsonString(body.stationId)
	) {
		throw new Error("Local bridge deploy response missing clientUrl/serverUrl");
	}
	return {
		exampleId: body.exampleId,
		stationId: body.stationId,
		clientUrl: body.clientUrl,
		serverUrl: body.serverUrl,
	};
}

export async function stopLocalBridgeDeploy(
	baseUrl = resolveLocalBridgeBase(),
): Promise<void> {
	await fetch(`${baseUrl}/stop`, {
		method: "POST",
		signal: AbortSignal.timeout(60_000),
	}).catch(() => {
		/* best-effort */
	});
}

export function createBridgeStationHost(clientUrl: string): BridgeStationHost {
	return {
		url: clientUrl,
		revoke() {
			/* remote compose lifecycle owned by bridge /stop */
		},
	};
}
