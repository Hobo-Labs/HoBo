/**
 * ZeroDeploy Drop API — anon static/site hosting (no auth).
 * POST https://api.zerodeploy.dev/drop — tar.gz → live URL (72h).
 * NOT a Docker/OCI runner — reject for Convex/Wasp server kinds.
 * Sources: zerodeploy.dev/agents (checked 2026-08).
 */
import { type JsonObject } from "../../src/lib/json-inspect.js";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	AnonContainerHostError,
	type AnonContainerDeployInput,
	type AnonContainerHostResult,
} from "./types.mts";

export const ZERODEPLOY_DROP_URL = "https://api.zerodeploy.dev/drop";
export const ZERODEPLOY_TIMEOUT_MS = 45_000;

async function tarGzDir(workDir: string): Promise<Buffer> {
	const staging = await mkdtemp(path.join(tmpdir(), "hobo-zd-tar-"));
	const outFile = path.join(staging, "site.tar.gz");
	try {
		const code = await new Promise<number>((resolve, reject) => {
			const child = spawn("tar", ["czf", outFile, "-C", workDir, "."], {
				stdio: ["ignore", "ignore", "pipe"],
			});
			child.on("error", reject);
			child.on("close", (c) => resolve(c ?? 1));
		});
		if (code !== 0) {
			throw new AnonContainerHostError(
				"zerodeploy",
				`tar czf failed (exit ${code})`,
			);
		}
		return await readFile(outFile);
	} finally {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
	}
}

export async function provisionZerodeployDrop(
	input: AnonContainerDeployInput,
): Promise<AnonContainerHostResult> {
	if (input.mock) {
		return {
			ok: true,
			host: "zerodeploy",
			url: "https://mock-site.zerodeploy.app",
			claimUrl: "https://dashboard.zerodeploy.dev/drop-claim?token=mock",
			kind: "node-source",
			anonymous: true,
			temporary: true,
			mocked: true,
			detail: "mock ZeroDeploy Drop (static/tar only — not OCI)",
		};
	}

	const archive = await tarGzDir(input.workDir);
	const fetchImpl = input.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ZERODEPLOY_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetchImpl(ZERODEPLOY_DROP_URL, {
			method: "POST",
			headers: input.projectHint
				? {
						"Content-Type": "application/gzip",
						"X-ZeroDeploy-Name": input.projectHint.slice(0, 64),
					}
				: { "Content-Type": "application/gzip" },
			body: archive,
			signal: input.signal ?? controller.signal,
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new AnonContainerHostError(
			"zerodeploy",
			`ZeroDeploy Drop unreachable (one-shot): ${reason}`,
		);
	} finally {
		clearTimeout(timer);
	}

	const text = await response.text();
	let parsed: JsonObject = {};
	try {
		// SAFETY: assertion required at this I/O boundary.
		parsed = JSON.parse(text) as JsonObject;
	} catch {
		/* raw */
	}
	if (!response.ok) {
		throw new AnonContainerHostError(
			"zerodeploy",
			`ZeroDeploy Drop failed HTTP ${response.status}: ${text.slice(0, 400)}`,
			response.status,
		);
	}
	// Live shape (2026-08): { data: { url, claim_token, expires_at }, next_steps? }
	// SAFETY: nested `data` object is a JSON bag from the Drop response.
	const data =
		parsed.data && Object.prototype.toString.call(parsed.data) === "[object Object]"
			? (parsed.data as JsonObject)
			: parsed;
	const url = Object.prototype.toString.call(data.url) === "[object String]" ? data.url : "";
	if (!url) {
		throw new AnonContainerHostError(
			"zerodeploy",
			`ZeroDeploy response missing url: ${text.slice(0, 400)}`,
		);
	}
	const claimToken =
		Object.prototype.toString.call(data.claim_token) === "[object String]" ? data.claim_token : "";
	// SAFETY: assertion required at this I/O boundary.
	const next = (parsed.next_steps ?? data.next_steps) as
		| { claim?: { url?: string } }
		| undefined;
	return {
		ok: true,
		host: "zerodeploy",
		url,
		claimUrl:
			(Object.prototype.toString.call(next?.claim?.url) === "[object String]" && next.claim.url) ||
			(claimToken
				? `https://dashboard.zerodeploy.dev/drop-claim?token=${claimToken}`
				: undefined),
		expiresAt:
			Object.prototype.toString.call(data.expires_at) === "[object String]" ? data.expires_at : undefined,
		kind: "node-source",
		anonymous: true,
		temporary: true,
		detail: "ZeroDeploy Drop — static/tar.gz only (not Docker/OCI)",
	};
}
