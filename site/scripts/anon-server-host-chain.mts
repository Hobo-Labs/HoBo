/**
 * Anon OpenSaaS server host chain (zero project API keys).
 *
 * 1) OpenPouch HTTP Instant Lane — one-shot; 429 → cooldown
 * 2) Clawdship Docker (zero-signup competitor) — one-shot; cooldown
 * 3) Cloudflare Temporary Worker + Neon HTTP shim — last resort
 *
 * Never loops/retries free anon hosts (avoids DDoS).
 * Instanode blacklisted (dead 404 API) — never probed here.
 */
import { type JsonObject } from "../src/lib/json-inspect.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	isRateLimitMessage,
	readHostCooldown,
	writeHostCooldown,
} from "./anon-container-hosts/cooldown.mts";
import { provisionClawdship } from "./anon-container-hosts/clawdship.mts";
import {
	provisionCloudflareTempNeonServer,
	type CloudflareTempNeonServerResult,
} from "./cloudflare-temp-neon-server.mts";
import {
	OpenpouchAnonServerError,
	provisionOpenpouchAnonServer,
	stageOpenSaasAnonServerBundle,
	writeOpenSaasAnonDockerfile,
	type OpenpouchAnonServerResult,
} from "./openpouch-anon-server.mts";

export type AnonServerHostMode =
	| "openpouch-anon"
	| "clawdship-anon"
	| "cloudflare-temp-neon";

export type AnonServerHostResult =
	| (OpenpouchAnonServerResult & { readonly fallbackFrom?: string })
	| {
			readonly ok: true;
			readonly serverUrl: string;
			readonly claimUrl?: string;
			readonly expiresAt?: string;
			readonly authenticated: false;
			readonly ownership: "anonymous";
			readonly mode: "clawdship-anon";
			readonly mocked: boolean;
			readonly fallbackFrom?: string;
	  }
	| (CloudflareTempNeonServerResult & { readonly fallbackFrom?: string });

/** @deprecated use per-host cooldown under HOBO_ANON_HOST_COOLDOWN_DIR */
export const OPENPOUCH_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export function openpouchCooldownPath(): string {
	return (
		process.env.HOBO_OPENPOUCH_COOLDOWN_FILE?.trim() ||
		path.join(tmpdir(), "hobo-openpouch-cooldown.json")
	);
}

export type OpenpouchCooldown = {
	readonly until: number;
	readonly reason: string;
	readonly at: string;
};

export function isOpenpouchRateLimitMessage(message: string): boolean {
	return isRateLimitMessage(message);
}

export async function readOpenpouchCooldown(
	filePath = openpouchCooldownPath(),
): Promise<OpenpouchCooldown | null> {
	try {
		const raw = await readFile(filePath, "utf8");
		// SAFETY: assertion required at this I/O boundary.
		const parsed = JSON.parse(raw) as Partial<OpenpouchCooldown>;
		if (Object.prototype.toString.call(parsed.until) !== "[object Number]" || parsed.until <= Date.now()) {
			return null;
		}
		return {
			until: parsed.until,
			reason: Object.prototype.toString.call(parsed.reason) === "[object String]" ? parsed.reason : "cooldown",
			at: Object.prototype.toString.call(parsed.at) === "[object String]" ? parsed.at : new Date().toISOString(),
		};
	} catch {
		return null;
	}
}

export async function writeOpenpouchCooldown(
	reason: string,
	ms = OPENPOUCH_COOLDOWN_MS,
	filePath = openpouchCooldownPath(),
): Promise<OpenpouchCooldown> {
	const payload: OpenpouchCooldown = {
		until: Date.now() + ms,
		reason: reason.slice(0, 400),
		at: new Date().toISOString(),
	};
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
	// Keep new per-host cooldown in sync for chain adapters.
	await writeHostCooldown("openpouch-http", reason, ms);
	return payload;
}

function debugLog(
	hypothesisId: string,
	location: string,
	message: string,
	data: JsonObject,
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

export type ProvisionAnonOpenSaasServerInput = {
	readonly waspAbsRoot: string;
	readonly databaseUrl: string;
	readonly webClientUrl: string;
	readonly mock?: boolean;
	/** auto (default) | openpouch | clawdship | cloudflare */
	readonly prefer?: "auto" | "openpouch" | "clawdship" | "cloudflare";
};

function parseServerHostPrefer(
	raw: string | undefined,
): "auto" | "openpouch" | "clawdship" | "cloudflare" {
	const trimmed = raw?.trim();
	if (
		trimmed === "auto" ||
		trimmed === "openpouch" ||
		trimmed === "clawdship" ||
		trimmed === "cloudflare"
	) {
		return trimmed;
	}
	return "auto";
}

async function provisionClawdshipAnonServer(input: {
	readonly waspAbsRoot: string;
	readonly databaseUrl: string;
	readonly webClientUrl: string;
	readonly mock?: boolean;
}): Promise<Extract<AnonServerHostResult, { mode: "clawdship-anon" }>> {
	if (input.mock) {
		return {
			ok: true,
			serverUrl: "https://hobo-opensaas-mock.clawdship.dev",
			authenticated: false,
			ownership: "anonymous",
			mode: "clawdship-anon",
			mocked: true,
		};
	}
	const staging = await stageOpenSaasAnonServerBundle(input.waspAbsRoot);
	try {
		await writeOpenSaasAnonDockerfile(staging, 8080);
		const deployed = await provisionClawdship({
			workDir: staging,
			projectHint: `hobo-opensaas-${Date.now().toString(36).slice(-6)}`,
			port: 8080,
			type: "docker",
			env: {
				DATABASE_URL: input.databaseUrl,
				WASP_WEB_CLIENT_URL: input.webClientUrl,
				WASP_SERVER_URL: "https://placeholder.clawdship.dev",
				PORT: "8080",
				NODE_ENV: "development",
			},
		});
		return {
			ok: true,
			serverUrl: deployed.url,
			claimUrl: deployed.claimUrl,
			expiresAt: deployed.expiresAt,
			authenticated: false,
			ownership: "anonymous",
			mode: "clawdship-anon",
			mocked: false,
		};
	} finally {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Prefer OpenPouch → Clawdship competitor → CF Temporary Neon shim.
 */
export async function provisionAnonOpenSaasServer(
	input: ProvisionAnonOpenSaasServerInput,
): Promise<AnonServerHostResult> {
	const prefer = input.prefer ?? parseServerHostPrefer(process.env.HOBO_OPENSAAS_SERVER_HOST);

	if (input.mock) {
		const server = await provisionOpenpouchAnonServer({
			waspAbsRoot: input.waspAbsRoot,
			databaseUrl: input.databaseUrl,
			webClientUrl: input.webClientUrl,
			mock: true,
		});
		debugLog("D", "anon-server-host-chain.mts:mock", "mock openpouch server", {
			mode: server.mode,
		});
		return server;
	}

	const forceCf = prefer === "cloudflare";
	const forceOpenpouch = prefer === "openpouch";
	const forceClawdship = prefer === "clawdship";
	const legacyCooldown = forceCf ? null : await readOpenpouchCooldown();
	const openpouchHostCooldown = forceCf
		? null
		: await readHostCooldown("openpouch-http");
	const clawdshipCooldown =
		forceCf || forceOpenpouch
			? null
			: await readHostCooldown("clawdship");

	debugLog("A", "anon-server-host-chain.mts:entry", "host chain start", {
		prefer,
		forceCf,
		forceOpenpouch,
		forceClawdship,
		openpouchCooldown: Boolean(legacyCooldown || openpouchHostCooldown),
		clawdshipCooldown: Boolean(clawdshipCooldown),
	});

	const skipOpenpouch =
		forceCf ||
		forceClawdship ||
		Boolean(legacyCooldown || openpouchHostCooldown);

	if (!skipOpenpouch) {
		try {
			debugLog(
				"B",
				"anon-server-host-chain.mts:openpouch",
				"one-shot OpenPouch attempt",
				{ prefer },
			);
			const server = await provisionOpenpouchAnonServer({
				waspAbsRoot: input.waspAbsRoot,
				databaseUrl: input.databaseUrl,
				webClientUrl: input.webClientUrl,
				mock: false,
			});
			debugLog(
				"B",
				"anon-server-host-chain.mts:openpouch-ok",
				"OpenPouch succeeded",
				{
					mode: server.mode,
					host: new URL(server.serverUrl).hostname,
				},
			);
			return server;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const rateLimited = isOpenpouchRateLimitMessage(message);
			if (rateLimited) {
				const written = await writeOpenpouchCooldown(message);
				debugLog(
					"A",
					"anon-server-host-chain.mts:cooldown",
					"OpenPouch rate limit → cooldown",
					{
						until: written.until,
						reason: written.reason.slice(0, 120),
					},
				);
			} else {
				debugLog(
					"B",
					"anon-server-host-chain.mts:openpouch-fail",
					"OpenPouch failed (non-429)",
					{ message: message.slice(0, 200) },
				);
			}
			if (forceOpenpouch) {
				throw error instanceof OpenpouchAnonServerError
					? error
					: new OpenpouchAnonServerError(message);
			}
			// fall through to Clawdship / CF
		}
	} else if (legacyCooldown || openpouchHostCooldown) {
		debugLog(
			"A",
			"anon-server-host-chain.mts:skip-openpouch",
			"skip OpenPouch (cooldown)",
			{
				until: (legacyCooldown ?? openpouchHostCooldown)?.until ?? null,
			},
		);
	}

	const skipClawdship = forceCf || forceOpenpouch || Boolean(clawdshipCooldown);
	if (!skipClawdship) {
		try {
			debugLog(
				"H2",
				"anon-server-host-chain.mts:clawdship",
				"one-shot Clawdship competitor attempt",
				{ prefer },
			);
			const server = await provisionClawdshipAnonServer({
				waspAbsRoot: input.waspAbsRoot,
				databaseUrl: input.databaseUrl,
				webClientUrl: input.webClientUrl,
				mock: false,
			});
			debugLog(
				"H2",
				"anon-server-host-chain.mts:clawdship-ok",
				"Clawdship succeeded",
				{
					mode: server.mode,
					host: new URL(server.serverUrl).hostname,
				},
			);
			return {
				...server,
				fallbackFrom: skipOpenpouch ? "openpouch-skip" : "openpouch-error",
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (isRateLimitMessage(message)) {
				await writeHostCooldown("clawdship", message);
			}
			debugLog(
				"H4",
				"anon-server-host-chain.mts:clawdship-fail",
				"Clawdship failed (continue)",
				{ message: message.slice(0, 200) },
			);
			if (forceClawdship) {
				throw new Error(`Clawdship anon server failed: ${message}`);
			}
		}
	} else if (clawdshipCooldown) {
		debugLog(
			"H3",
			"anon-server-host-chain.mts:skip-clawdship",
			"skip Clawdship (cooldown)",
			{ until: clawdshipCooldown.until },
		);
	}

	const cf = await provisionCloudflareTempNeonServer({
		databaseUrl: input.databaseUrl,
	});
	debugLog("C", "anon-server-host-chain.mts:cf", "CF Neon server selected", {
		mode: cf.mode,
		host: new URL(cf.serverUrl).hostname,
		from: forceCf
			? "prefer-cloudflare"
			: skipOpenpouch
				? "openpouch-cooldown-or-skip"
				: "competitors-failed",
	});
	return {
		...cf,
		fallbackFrom: forceCf
			? "prefer-cloudflare"
			: skipOpenpouch
				? "openpouch-cooldown"
				: "competitors-failed",
	};
}
