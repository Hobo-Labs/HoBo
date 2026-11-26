/**
 * Netlify anonymous Environment Station provision
 * (`netlify deploy --allow-anonymous` / Netlify Drop claim flow).
 *
 * Temporary path never uses permanent `NETLIFY_AUTH_TOKEN` /
 * `NETLIFY_ACCESS_TOKEN`. Tests and CI inject a transport or set
 * `HOBO_NETLIFY_TEMP_MOCK=1` at the Examples broker.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	TEMPORARY_STATION_TTL_MS,
	type TemporaryEnvironmentStationResult,
	temporaryStationExpiresAt,
} from "@hobo/core";
import { NETLIFY_ANONYMOUS_CLAIM_WINDOW_MS } from "./deploy-output.js";
import { runIsolatedNetlifyAnonymousDeploy } from "./isolated-deploy.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "./json.js";
import { PROVIDER_TARGET } from "./options.js";
import {
	createNodeProcessRunner,
	type ProcessRunner,
} from "./process-runner.js";
import { NetlifyProviderError } from "./provider-errors.js";

export const NETLIFY_TEMPORARY_PROVIDER_ID = PROVIDER_TARGET;
export const supportsAnonymousTemporaryDeploy = true as const;

/** public-contract: Drop / claim landing for operators. */
export const NETLIFY_DROP_URL = "https://app.netlify.com/drop";

export type NetlifyAnonymousDeployResult = {
	readonly deployId: string;
	readonly stationUrl: string;
	readonly claimUrl: string;
};

export type NetlifyAnonymousTransport = {
	deployAnonymous(input: {
		readonly stationId: string;
		readonly workDir: string;
	}): Promise<NetlifyAnonymousDeployResult>;
};

export type NetlifyDropFile = {
	readonly file: string;
	readonly data: string;
	readonly encoding?: "utf-8" | "base64";
};

export type NetlifyTemporaryStationInput = {
	readonly stationId: string;
	readonly transport?: NetlifyAnonymousTransport;
	readonly files?: readonly NetlifyDropFile[];
	readonly workDir?: string;
};

const DEFAULT_STATION_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HoBo Environment Station · Netlify</title>
</head>
<body data-hobo-station="netlify" data-anonymous="true">
  <main>
    <h1>HoBo Environment Station</h1>
    <p>Provisioned via <code>netlify deploy --allow-anonymous</code> (claim within ~1h).</p>
    <p><a href="${NETLIFY_DROP_URL}">Netlify Drop</a></p>
  </main>
</body>
</html>
`;

function validateAnonymousResult(
	result: NetlifyAnonymousDeployResult,
): NetlifyAnonymousDeployResult {
	const station = new URL(result.stationUrl),
		claim = new URL(result.claimUrl);
	if (
		station.protocol !== "https:" ||
		!station.hostname.endsWith(".netlify.app") ||
		station.username ||
		station.password ||
		station.port
	)
		throw new Error(
			"Netlify station URL is outside its HTTPS hosting authority",
		);
	if (
		claim.protocol !== "https:" ||
		claim.hostname !== "app.netlify.com" ||
		claim.username ||
		claim.password ||
		claim.port ||
		!/^\/(?:claim|drop)(?:\/|$)/u.test(claim.pathname)
	)
		throw new Error(
			"Netlify claim URL is outside its dashboard ownership authority",
		);
	return result;
}

function jsonNonEmptyString(value: JsonValue | undefined): string {
	return isJsonString(value) && value.length > 0 ? value : "";
}

function resultFromNetlifyJson(
	parsed: JsonObject,
): NetlifyAnonymousDeployResult | null {
	const urlRaw =
		jsonNonEmptyString(parsed.site_url) ||
		jsonNonEmptyString(parsed.url) ||
		jsonNonEmptyString(parsed.deploy_url) ||
		jsonNonEmptyString(parsed.deployUrl) ||
		jsonNonEmptyString(parsed.ssl_url);
	const stationUrlRaw = urlRaw.startsWith("http")
		? urlRaw
		: urlRaw
			? `https://${urlRaw}`
			: "";
	// CLI may emit http://*.netlify.app — normalize to https for browsers.
	const stationUrl = stationUrlRaw.replace(/^http:\/\//u, "https://");
	const deployId =
		jsonNonEmptyString(parsed.deploy_id) || jsonNonEmptyString(parsed.deployId);
	let claimUrl =
		jsonNonEmptyString(parsed.claim_url) || jsonNonEmptyString(parsed.claimUrl);
	const password = jsonNonEmptyString(parsed.password);
	// Drop sites are password-gated until claimed — surface password on claimUrl.
	if (claimUrl && password && !claimUrl.includes("password=")) {
		claimUrl = `${claimUrl}${claimUrl.includes("#") ? "&" : "#"}password=${encodeURIComponent(password)}`;
	}
	if (!stationUrl) return null;
	if (!claimUrl || !deployId) return null;
	return validateAnonymousResult({
		deployId,
		stationUrl,
		claimUrl,
	});
}

/**
 * Parse `netlify deploy --allow-anonymous` stdout for live URL + claim material.
 * CLI `--json` often pretty-prints — accept whole-stdout JSON, single-line JSON,
 * or individual JSON lines. Text URLs alone do not establish resource identity.
 */
export function parseNetlifyAnonymousDeployOutput(
	stdout: string,
): NetlifyAnonymousDeployResult {
	const trimmed = stdout.trim();
	if (!trimmed) {
		throw new Error("netlify anonymous deploy produced empty output");
	}

	const jsonStart = trimmed.indexOf("{");
	const jsonEnd = trimmed.lastIndexOf("}");
	if (jsonStart >= 0 && jsonEnd > jsonStart) {
		const parsed = parseJsonValue(trimmed.slice(jsonStart, jsonEnd + 1));
		if (isJsonObject(parsed)) {
			const fromBlob = resultFromNetlifyJson(parsed);
			if (fromBlob) return fromBlob;
		}
	}

	for (const line of trimmed.split(/\r?\n/u)) {
		const candidate = line.trim();
		if (!candidate.startsWith("{")) continue;
		const parsed = parseJsonValue(candidate);
		if (!isJsonObject(parsed)) continue;
		const fromLine = resultFromNetlifyJson(parsed);
		if (fromLine) return fromLine;
	}

	// `netlify.app` must be the end of the *host*, not merely present somewhere
	// in the URL. The looser form matched `https://evil.example/netlify.app`,
	// which would have been adopted as the station URL — a path segment is not a
	// hostname, and this is the last-resort strategy, so it is the one place
	// where a wrong match is least likely to be noticed.
	const urlMatch = trimmed.match(
		/https?:\/\/[^\s"'<>/]+\.netlify\.app(?![A-Za-z0-9-])(?!\.[A-Za-z0-9])[^\s"'<>]*/iu,
	);
	if (!urlMatch) {
		throw new Error(
			"netlify anonymous deploy output missing *.netlify.app URL (see netlify deploy --allow-anonymous)",
		);
	}
	const claimMatch = trimmed.match(
		/https?:\/\/[^\s"'<>]*app\.netlify\.com\/[^\s"'<>]*(?:claim|drop)[^\s"'<>]*/iu,
	);
	if (!claimMatch)
		throw new Error(
			"netlify anonymous deploy has no observed ownership claim URL; refusing to invent one",
		);
	throw new Error(
		"netlify anonymous deployment has no observed JSON deployment identity; refusing to substitute a site hostname or account ID",
	);
}

async function runNetlifyAnonymousCli(
	input: {
		readonly workDir: string;
	},
	options: {
		readonly runner?: ProcessRunner;
		readonly env?: Readonly<Record<string, string | undefined>>;
	},
): Promise<NetlifyAnonymousDeployResult> {
	const result = await runIsolatedNetlifyAnonymousDeploy({
		runner: options.runner ?? createNodeProcessRunner(),
		workDir: input.workDir,
		publishDir: ".",
		env: options.env ?? process.env,
		timeoutMs: 120000,
		maxOutputBytes: 524288,
	});
	if (result.code !== 0)
		throw new NetlifyProviderError(
			"PROVIDER_OPERATION_AMBIGUOUS",
			"Netlify anonymous deployment did not complete; reconcile its observed site before creating another",
		);
	return parseNetlifyAnonymousDeployOutput(result.stdout || result.stderr);
}

export function createNetlifyAnonymousCliTransport(
	options: {
		readonly runner?: ProcessRunner;
		readonly env?: Readonly<Record<string, string | undefined>>;
	} = {},
): NetlifyAnonymousTransport {
	return {
		async deployAnonymous({ workDir }) {
			return runNetlifyAnonymousCli({ workDir }, options);
		},
	};
}

export async function materializeNetlifyStation(input: {
	readonly stationId: string;
	readonly files?: readonly NetlifyDropFile[];
	readonly rootDir?: string;
}): Promise<{
	readonly workDir: string;
	readonly files: readonly NetlifyDropFile[];
}> {
	const supplied =
		input.files ??
		([
			{
				file: "index.html",
				data: DEFAULT_STATION_HTML,
				encoding: "utf-8",
			},
		] as const);
	if (supplied.length === 0 || supplied.length > 256)
		throw new Error("Netlify station needs a bounded nonempty public file set");
	const seen = new Set<string>();
	let totalBytes = 0;
	const files = supplied.map((entry) => {
		const parts = entry.file.split("/");
		if (
			!entry.file ||
			path.posix.isAbsolute(entry.file) ||
			path.win32.isAbsolute(entry.file) ||
			entry.file.includes("\\") ||
			parts.some(
				(part) =>
					!part ||
					part === "." ||
					part === ".." ||
					[
						".netlify",
						"node_modules",
						".npmrc",
						"netlify.toml",
						".env",
						".git",
					].includes(part),
			) ||
			seen.has(entry.file)
		)
			throw new Error(
				"Netlify station file path escapes or overrides its isolated artifact directory",
			);
		seen.add(entry.file);
		const body =
			entry.encoding === "base64"
				? Buffer.from(entry.data, "base64")
				: Buffer.from(entry.data, "utf8");
		if (entry.encoding === "base64" && body.toString("base64") !== entry.data)
			throw new Error("Netlify station file is not canonical base64");
		totalBytes += body.byteLength;
		if (totalBytes > 2_097_152)
			throw new Error(
				"Netlify station artifact exceeds its aggregate byte bound",
			);
		return Object.freeze({ ...entry });
	});
	const root = input.rootDir ?? tmpdir();
	await mkdir(root, { recursive: true });
	const workDir = await mkdtemp(path.join(root, "hobo-netlify-anon-"));
	for (const entry of files) {
		const abs = path.join(workDir, entry.file);
		await mkdir(path.dirname(abs), { recursive: true, mode: 0o700 });
		const body =
			entry.encoding === "base64"
				? Buffer.from(entry.data, "base64")
				: entry.data;
		await writeFile(abs, body, { flag: "wx", mode: 0o600 });
	}
	return { workDir, files };
}

/**
 * Provision an Environment Station via Netlify anonymous deploy.
 * Never uses permanent Netlify auth tokens on this path.
 */
export async function provisionTemporaryEnvironmentStation(
	input: NetlifyTemporaryStationInput,
): Promise<TemporaryEnvironmentStationResult> {
	const { workDir } = await materializeNetlifyStation({
		stationId: input.stationId,
		...(input.files ? { files: input.files } : undefined),
		...(input.workDir ? { rootDir: input.workDir } : undefined),
	});
	const transport = input.transport ?? createNetlifyAnonymousCliTransport();
	const startedAtMs = Date.now();
	try {
		const deployed = validateAnonymousResult(
			await transport.deployAnonymous({ stationId: input.stationId, workDir }),
		);
		const ttlMs = Math.min(
			TEMPORARY_STATION_TTL_MS,
			NETLIFY_ANONYMOUS_CLAIM_WINDOW_MS,
		);
		const expiresAt = temporaryStationExpiresAt(ttlMs, startedAtMs);
		return {
			stationId: input.stationId,
			stationUrl: deployed.stationUrl,
			primaryUrl: deployed.stationUrl,
			claimUrl: deployed.claimUrl,
			expiresAt,
			ttlSeconds: ttlMs / 1000,
			providerId: NETLIFY_TEMPORARY_PROVIDER_ID,
			anonymous: true,
			temporary: true,
		};
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}
