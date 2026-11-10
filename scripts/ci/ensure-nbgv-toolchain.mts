#!/usr/bin/env node
/**
 * CI entry for release-main-train-gate: bounded dotnet install for nbgv with progress logs.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureNbgvToolchainAsync } from "../lib/nbgv-toolchain.mts";

const root = join(import.meta.dirname, "..", "..");

const defaultTimeoutMs = 180_000;

function parseTimeoutMs(): number {
	const raw = process.env.HOBO_NBGV_MISE_INSTALL_TIMEOUT_MS?.trim();
	if (!raw) return defaultTimeoutMs;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 30_000 || n > 600_000) {
		throw new Error(
			`HOBO_NBGV_MISE_INSTALL_TIMEOUT_MS must be 30000–600000, got ${raw}`,
		);
	}
	return Math.floor(n);
}

async function main(): Promise<void> {
	const timeoutMs = parseTimeoutMs();
	console.log(
		`nbgv-toolchain: preparing (timeout ${timeoutMs} ms; skip install when dotnet already resolves)`,
	);
	await ensureNbgvToolchainAsync(root, {
		timeoutMs,
		log: (line) => console.log(line),
	});
	console.log("nbgv-toolchain: ready");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await main();
}
