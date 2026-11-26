/**
 * Optional Schemathesis wrapper. PR lanes skip when the binary is missing
 * so default agent:check stays offline and docker-free.
 */
import { spawnSync } from "node:child_process";

import { schemathesisAvailable } from "./env.js";

export interface SchemathesisRun {
	readonly ran: boolean;
	readonly reason: string;
	readonly status?: number | null;
}

export function runSchemathesis(
	opts: { url?: string; spec?: string } = {},
): SchemathesisRun {
	if (!schemathesisAvailable()) {
		return {
			ran: false,
			reason: "schemathesis binary not on PATH",
		};
	}
	const url = opts.url ?? process.env.HOBO_FUZZ_API_URL;
	if (!url) {
		return {
			ran: false,
			reason: "HOBO_FUZZ_API_URL unset; refuse live-cloud default",
		};
	}
	if (/azure|amazonaws|googleapis|openai|anthropic/i.test(url)) {
		return {
			ran: false,
			reason: "refusing paid or public-cloud endpoint",
		};
	}
	const args = [
		"run",
		opts.spec ?? `${url.replace(/\/$/, "")}/v1/openapi.json`,
	];
	args.push("--url", url, "--checks", "all");
	const probe = spawnSync("schemathesis", args, {
		encoding: "utf8",
		timeout: 120_000,
	});
	return {
		ran: true,
		reason: probe.status === 0 ? "conformance ok" : probe.stderr || "failed",
		status: probe.status,
	};
}
