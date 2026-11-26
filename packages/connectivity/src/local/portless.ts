import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { isJsonString } from "../json.js";

export type PortlessMode = "auto" | "on" | "off";

export interface PortlessProbe {
	readonly available: boolean;
	readonly binPath: string | null;
	readonly version: string | null;
	readonly mode: PortlessMode;
	readonly enabled: boolean;
	readonly hint: string | null;
}

const PORTLESS_HINT =
	"named HTTPS URLs require portless (vercel-labs/portless); install it and run `portless trust` once, or set HOBO_PORTLESS=0 to silence this hint";

/**
 * Detect optional portless binary.
 * Never throws; local path remains port-based when unavailable.
 */
export function resolvePortlessMode(
	env: NodeJS.ProcessEnv = process.env,
): PortlessMode {
	const raw = (env.HOBO_PORTLESS ?? env.HOBO_NAMED_ENDPOINTS ?? "auto")
		.trim()
		.toLowerCase();
	if (raw === "0" || raw === "false" || raw === "off" || raw === "no") {
		return "off";
	}
	if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") {
		return "on";
	}
	return "auto";
}

export function probePortless(options?: {
	readonly env?: NodeJS.ProcessEnv;
	readonly binPath?: string;
	readonly runVersion?: (bin: string) => { ok: boolean; stdout: string };
}): PortlessProbe {
	const env = options?.env ?? process.env;
	const mode = resolvePortlessMode(env);
	const candidates = [
		options?.binPath,
		env.HOBO_PORTLESS_BIN,
		"portless",
	].filter((v): v is string => isJsonString(v) && v.length > 0);

	let binPath: string | null = null;
	let version: string | null = null;

	for (const candidate of candidates) {
		if (
			candidate !== "portless" &&
			!existsSync(candidate) &&
			!candidate.includes(delimiter)
		) {
			// absolute/relative path missing
			if (candidate.includes("/") || candidate.includes("\\")) continue;
		}
		const run =
			options?.runVersion ??
			((bin: string) => {
				const result = spawnSync(bin, ["--version"], { encoding: "utf8" });
				return {
					ok: result.status === 0,
					stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`,
				};
			});
		const probe = run(candidate);
		if (probe.ok) {
			binPath = candidate;
			version = probe.stdout.trim().split(/\s+/)[0] ?? probe.stdout.trim();
			break;
		}
	}

	const available = binPath !== null;
	const enabled =
		mode === "on" ? available : mode === "off" ? false : available;

	return {
		available,
		binPath,
		version,
		mode,
		enabled,
		hint: enabled || mode === "off" ? null : PORTLESS_HINT,
	};
}

/**
 * Register a hostname → backend URL mapping with portless when available.
 * Best-effort; failures are non-fatal for the local serve path.
 */
export async function registerPortlessRoute(options: {
	readonly hostname: string;
	readonly backendUrl: string;
	readonly binPath?: string;
	readonly run?: (args: readonly string[]) => {
		ok: boolean;
		stdout: string;
		stderr: string;
	};
}): Promise<{ readonly registered: boolean; readonly note?: string }> {
	const bin = options.binPath ?? "portless";
	const run =
		options.run ??
		((args) => {
			const result = spawnSync(bin, [...args], { encoding: "utf8" });
			return {
				ok: result.status === 0,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
			};
		});

	// Try a few CLI shapes; portless CLI surface varies by version.
	const attempts = [
		["proxy", "set", options.hostname, options.backendUrl],
		["set", options.hostname, options.backendUrl],
		["add", options.hostname, options.backendUrl],
	];
	for (const args of attempts) {
		const result = run(args);
		if (result.ok) {
			return { registered: true };
		}
	}
	return {
		registered: false,
		note: "portless present but route registration failed; using hierarchical names without proxy binding",
	};
}
