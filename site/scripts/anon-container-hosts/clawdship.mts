/**
 * Clawdship — OpenPouch-class competitor (agent-native, zero signup, static + Docker).
 * API: POST https://api.clawdship.dev/v1/sites (multipart archive).
 * Sources: clawdship.dev, DEV Community (ndlz), termo skill mirror.
 * First deploy auto-creates account + returns cship_ API key (7-day trial).
 * Do not loop/retry on timeout — one-shot only.
 */
import { type JsonObject } from "../../src/lib/json-inspect.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	AnonContainerHostError,
	type AnonContainerDeployInput,
	type AnonContainerHostResult,
} from "./types.mts";

export const CLAWDSHIP_API_BASE = "https://api.clawdship.dev/v1";
/** Single attempt budget — never extend into a probe loop. */
export const CLAWDSHIP_TIMEOUT_MS = 45_000;

export type ClawdshipDeployType = "static" | "docker";

export type ProvisionClawdshipInput = AnonContainerDeployInput & {
	readonly type?: ClawdshipDeployType;
	/** Optional saved key from prior first-deploy (operator path). */
	readonly apiKey?: string;
};

async function tarGzDir(workDir: string): Promise<Buffer> {
	const staging = await mkdtemp(path.join(tmpdir(), "hobo-claw-tar-"));
	const outFile = path.join(staging, "archive.tar.gz");
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
				"clawdship",
				`tar czf failed (exit ${code})`,
			);
		}
		return await readFile(outFile);
	} finally {
		await rm(staging, { recursive: true, force: true }).catch(() => {});
	}
}

function sanitizeSlug(hint: string | undefined): string {
	const raw = (hint ?? `hobo-${randomBytes(3).toString("hex")}`)
		.toLowerCase()
		.replace(/[^a-z0-9-]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 48);
	return raw || `hobo-${randomBytes(3).toString("hex")}`;
}

export async function provisionClawdship(
	input: ProvisionClawdshipInput,
): Promise<AnonContainerHostResult> {
	const type = input.type ?? "docker";
	const slug = sanitizeSlug(input.projectHint);
	const port = input.port ?? 8080;

	if (input.mock) {
		return {
			ok: true,
			host: "clawdship",
			url: `https://${slug}.clawdship.dev`,
			kind: type === "docker" ? "dockerfile" : "node-source",
			anonymous: true,
			temporary: true,
			mocked: true,
			detail: "mock clawdship 7d trial",
		};
	}

	const archive = await tarGzDir(input.workDir);
	const form = new FormData();
	form.set("name", slug);
	form.set("type", type);
	form.set("slug", slug);
	if (type === "docker") form.set("port", String(port));
	form.set(
		"archive",
		new Blob([new Uint8Array(archive)], { type: "application/gzip" }),
		"archive.tar.gz",
	);
	if (input.env) {
		for (const [key, value] of Object.entries(input.env)) {
			form.set(`envVars[${key}]`, value);
		}
	}

	const headers: Record<string, string> = {};
	const apiKey =
		input.apiKey?.trim() || process.env.CLAWDSHIP_API_KEY?.trim() || "";
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	const fetchImpl = input.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CLAWDSHIP_TIMEOUT_MS);
	const signal = input.signal ?? controller.signal;
	let response: Response;
	try {
		response = await fetchImpl(`${CLAWDSHIP_API_BASE}/sites`, {
			method: "POST",
			headers,
			body: form,
			signal,
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new AnonContainerHostError(
			"clawdship",
			`Clawdship unreachable (one-shot, no retry): ${reason}`,
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
			"clawdship",
			`Clawdship deploy failed HTTP ${response.status}: ${text.slice(0, 400)}`,
			response.status,
		);
	}
	const url =
		(Object.prototype.toString.call(parsed.url) === "[object String]" && parsed.url) ||
		(Object.prototype.toString.call(parsed.siteUrl) === "[object String]" && parsed.siteUrl) ||
		"";
	if (!url) {
		throw new AnonContainerHostError(
			"clawdship",
			`Clawdship response missing url: ${text.slice(0, 400)}`,
		);
	}
	// Never log apiKey from response — only surface claim/billing URL if present.
	const claimUrl =
		(Object.prototype.toString.call(parsed.billingUrl) === "[object String]" && parsed.billingUrl) ||
		(Object.prototype.toString.call(parsed.claimUrl) === "[object String]" && parsed.claimUrl) ||
		undefined;
	return {
		ok: true,
		host: "clawdship",
		url,
		claimUrl,
		expiresAt:
			Object.prototype.toString.call(parsed.trialEnds) === "[object String]" ? parsed.trialEnds : undefined,
		kind: type === "docker" ? "dockerfile" : "node-source",
		anonymous: true,
		temporary: true,
		detail: "clawdship zero-signup / 7d trial (Docker+static)",
	};
}
