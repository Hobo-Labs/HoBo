/**
 * Ordered anon container/host chain — one-shot per host + cooldown.
 * Never loops. Never re-probes blacklisted dead APIs (Instanode).
 */
import type { DebugFields } from "../../src/lib/json-inspect.js";
import {
	isRateLimitMessage,
	readHostCooldown,
	writeHostCooldown,
} from "./cooldown.mts";
import { provisionAppishCrane } from "./appish-crane.mts";
import { provisionClawdship } from "./clawdship.mts";
import { provisionOpenpouchHttp } from "./openpouch-http.mts";
import { provisionZerodeployDrop } from "./zerodeploy.mts";
import {
	AnonContainerHostError,
	type AnonContainerDeployInput,
	type AnonContainerHostId,
	type AnonContainerHostResult,
} from "./types.mts";

export type AnonHostChainKind = "node-dynamic" | "docker-source" | "oci-image";

export type RunAnonHostChainInput = AnonContainerDeployInput & {
	readonly chainKind: AnonHostChainKind;
	/** OCI source for appish (required when chainKind=oci-image). */
	readonly sourceImage?: string;
	readonly hosts?: readonly AnonContainerHostId[];
};

const NODE_DYNAMIC_DEFAULT: readonly AnonContainerHostId[] = [
	"openpouch-http",
	"clawdship",
];

const DOCKER_SOURCE_DEFAULT: readonly AnonContainerHostId[] = [
	"clawdship",
	"openpouch-http",
];

const OCI_IMAGE_DEFAULT: readonly AnonContainerHostId[] = [
	"appish-crane",
	"clawdship",
];

function defaultHosts(kind: AnonHostChainKind): readonly AnonContainerHostId[] {
	switch (kind) {
		case "node-dynamic":
			return NODE_DYNAMIC_DEFAULT;
		case "docker-source":
			return DOCKER_SOURCE_DEFAULT;
		case "oci-image":
			return OCI_IMAGE_DEFAULT;
		default:
			return NODE_DYNAMIC_DEFAULT;
	}
}

function debugLog(
	hypothesisId: string,
	location: string,
	message: string,
	data: DebugFields,
): void {
	// #region agent log
	fetch("http://127.0.0.1:7655/ingest/eac23247-0462-43c4-8e6e-14b2a6cecba6", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Debug-Session-Id": "2dc295",
		},
		body: JSON.stringify({
			sessionId: "2dc295",
			runId: process.env.HOBO_DEBUG_RUN_ID ?? "pre-fix",
			hypothesisId,
			location,
			message,
			data,
			timestamp: Date.now(),
		}),
	}).catch(() => {});
	// #endregion
}

async function tryHost(
	host: AnonContainerHostId,
	input: RunAnonHostChainInput,
): Promise<AnonContainerHostResult> {
	switch (host) {
		case "openpouch-http":
			return provisionOpenpouchHttp(input);
		case "clawdship":
			return provisionClawdship({
				...input,
				type: input.chainKind === "node-dynamic" ? "docker" : "docker",
			});
		case "zerodeploy":
			if (input.chainKind !== "node-dynamic") {
				throw new AnonContainerHostError(
					"zerodeploy",
					"ZeroDeploy Drop is static/tar only — skipped for docker/oci kinds",
				);
			}
			return provisionZerodeployDrop(input);
		case "appish-crane": {
			if (!input.sourceImage?.trim()) {
				throw new AnonContainerHostError(
					"appish-crane",
					"APPISH requires sourceImage (OCI ref)",
				);
			}
			return provisionAppishCrane({
				...input,
				sourceImage: input.sourceImage,
			});
		}
		case "lakebed-anon":
			throw new AnonContainerHostError(
				"lakebed-anon",
				"Lakebed anon is capsule IR — not wired in this chain (use lakebed CLI path)",
			);
		default: {
			const _exhaustive: never = host;
			throw new Error(`unknown anon host: ${_exhaustive}`);
		}
	}
}

export type AnonHostChainFailure = {
	readonly host: AnonContainerHostId;
	readonly message: string;
	readonly cooledDown?: boolean;
	readonly skippedCooldown?: boolean;
};

export type AnonHostChainOutcome =
	| (AnonContainerHostResult & {
			readonly fallbackFrom?: string;
			readonly attempts: readonly AnonHostChainFailure[];
	  })
	| {
			readonly ok: false;
			readonly attempts: readonly AnonHostChainFailure[];
			readonly error: string;
	  };

/**
 * Try hosts in order. One attempt each. Rate-limit → cooldown file.
 */
export async function runAnonHostChain(
	input: RunAnonHostChainInput,
): Promise<AnonHostChainOutcome> {
	const hosts = input.hosts ?? defaultHosts(input.chainKind);
	const attempts: AnonHostChainFailure[] = [];

	debugLog("H1", "chain.mts:entry", "anon host chain start", {
		chainKind: input.chainKind,
		hosts: [...hosts],
		mock: Boolean(input.mock),
		hasSourceImage: Boolean(input.sourceImage),
	});

	for (const host of hosts) {
		const cooldown = input.mock ? null : await readHostCooldown(host);
		if (cooldown) {
			attempts.push({
				host,
				message: `cooldown until ${new Date(cooldown.until).toISOString()}: ${cooldown.reason}`,
				skippedCooldown: true,
			});
			debugLog("H3", "chain.mts:skip-cooldown", "skip host (cooldown)", {
				host,
				until: cooldown.until,
			});
			continue;
		}

		try {
			debugLog("H2", "chain.mts:try", "one-shot host attempt", { host });
			const result = await tryHost(host, input);
			debugLog("H2", "chain.mts:ok", "host succeeded", {
				host,
				urlHost: (() => {
					try {
						return new URL(result.url).hostname;
					} catch {
						return "(bad-url)";
					}
				})(),
				mocked: Boolean(result.mocked),
			});
			return {
				...result,
				fallbackFrom:
					attempts.length > 0
						? attempts.map((a) => a.host).join(",")
						: undefined,
				attempts,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const rateLimited = isRateLimitMessage(message);
			if (rateLimited && !input.mock) {
				await writeHostCooldown(host, message);
			}
			attempts.push({
				host,
				message: message.slice(0, 400),
				cooledDown: rateLimited,
			});
			debugLog("H4", "chain.mts:fail", "host failed (continue)", {
				host,
				rateLimited,
				message: message.slice(0, 200),
			});
		}
	}

	const error = `Anon host chain exhausted (${input.chainKind}): ${attempts
		.map((a) => `${a.host}: ${a.message}`)
		.join(" | ")}`;
	debugLog("H5", "chain.mts:exhausted", "all hosts failed", {
		chainKind: input.chainKind,
		attemptCount: attempts.length,
	});
	return { ok: false, attempts, error };
}
