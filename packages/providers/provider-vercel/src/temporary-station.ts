/** Vercel Drop is a browser ceremony. The account-backed Vercel CLI is not an
 * anonymous API and must never be launched as a temporary deployment fallback. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TemporaryEnvironmentStationResult } from "@hobo/core";
import type { VercelAnonymousDeploymentEvidenceRecord } from "./_generated/anonymous_deployment_pb.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonValue,
} from "./json.js";
import { PROVIDER_TARGET } from "./options.js";
export const VERCEL_TEMPORARY_PROVIDER_ID = PROVIDER_TARGET;
/** The SDK has no provider-documented anonymous API; account-backed REST
 * deployments are available through vercel.static-deploy/v1 instead. */
export { supportsAnonymousTemporaryDeploy } from "./temporary-capability.js";
// public-contract: Vercel Drop landing page retained in availability diagnostics.
export const VERCEL_DROP_URL = "https://vercel.com/drop";
export type VercelDropFile = {
	readonly file: string;
	readonly data: string;
	readonly encoding?: "utf-8" | "base64";
};
export type VercelDropDeployResult = Readonly<
	Pick<
		VercelAnonymousDeploymentEvidenceRecord,
		| "projectName"
		| "deploymentId"
		| "stationUrl"
		| "claimUrl"
		| "anonymous"
		| "expiresAt"
	>
> & { readonly expirySource?: "provider-reported" };
export type VercelDropTransport = {
	deployDrop(input: {
		readonly stationId: string;
		readonly projectName: string;
		readonly files: readonly VercelDropFile[];
		readonly workDir: string;
	}): Promise<VercelDropDeployResult>;
};
export type VercelTemporaryStationInput = {
	readonly stationId: string;
	readonly transport?: VercelDropTransport;
	readonly files?: readonly VercelDropFile[];
	readonly projectName?: string;
};
export function sanitizeVercelDropProjectName(stationId: string): string {
	const compact = stationId
		.replace(/[^a-z0-9]+/giu, "-")
		.replace(/^-+|-+$/gu, "")
		.toLowerCase()
		.slice(-40);
	return `hobo-drop-${compact || "anon"}`.slice(0, 52);
}
type VercelDropDeployOutput = {
	readonly stationUrl: string;
	readonly deploymentId: string;
	readonly projectName?: string;
};
function stationUrl(raw: string): string {
	const url = new URL(
		raw.startsWith("https://") || raw.startsWith("http://")
			? raw
			: `https://${raw}`,
	);
	if (
		url.protocol !== "https:" ||
		!url.hostname.endsWith(".vercel.app") ||
		url.username ||
		url.password ||
		url.port ||
		url.search ||
		url.hash
	)
		throw new Error("Vercel deployment URL leaves its HTTPS hosting authority");
	return url.toString().replace(/\/$/u, "");
}
function fromJson(value: JsonObject): VercelDropDeployOutput | undefined {
	const raw = value.url ?? value.alias,
		id = value.id ?? value.deploymentId,
		name = value.projectName ?? value.name;
	if (!isJsonString(raw) || !isJsonString(id) || !id) return undefined;
	return {
		stationUrl: stationUrl(raw),
		deploymentId: id,
		...(isJsonString(name) && name ? { projectName: name } : undefined),
	};
}
/** Native JSON identity is required; a hostname cannot stand in for an ID. */
export function parseVercelDropDeployOutput(
	stdout: string,
): VercelDropDeployOutput {
	if (!stdout.trim())
		throw new Error("vercel Drop deploy produced empty output");
	const start = stdout.indexOf("{"),
		end = stdout.lastIndexOf("}");
	const candidates = [
		...(start >= 0 && end > start ? [stdout.slice(start, end + 1)] : []),
		...stdout.split(/\r?\n/u),
	];
	for (const candidate of candidates) {
		const value = parseJsonValue(candidate);
		if (isJsonObject(value)) {
			const parsed = fromJson(value);
			if (parsed) return parsed;
		}
	}
	throw new Error(
		"Vercel deployment output lacks observed JSON resource identity; refusing to invent an ID or claim URL",
	);
}
/** Kept as a compatibility factory, with no subprocess or account side effect. */
export function createVercelDropCliTransport(): VercelDropTransport {
	return {
		async deployDrop() {
			throw new Error(
				"Vercel CLI uses an authenticated account and cannot provide anonymous temporary deployments; use the scoped REST deployment resolver or an independently verified anonymous transport",
			);
		},
	};
}
export async function materializeVercelDropStation(input: {
	readonly stationId: string;
	readonly files?: readonly VercelDropFile[];
	readonly rootDir?: string;
}): Promise<{
	readonly workDir: string;
	readonly files: readonly VercelDropFile[];
}> {
	const files = input.files ?? [
		{
			file: "index.html",
			data: "<!doctype html><title>HoBo Environment Station</title><h1>HoBo Environment Station</h1>",
			encoding: "utf-8" as const,
		},
	];
	if (!files.length || files.length > 256)
		throw new Error("Vercel artifact requires a bounded nonempty file set");
	let bytes = 0;
	const seen = new Set<string>();
	for (const entry of files) {
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
						".git",
						".vercel",
						"node_modules",
						".env",
						"vercel.json",
						"package.json",
					].includes(part),
			) ||
			seen.has(entry.file)
		)
			throw new Error(
				"Vercel artifact path escapes or overrides its isolated public artifact",
			);
		seen.add(entry.file);
		const data =
			entry.encoding === "base64"
				? Buffer.from(entry.data, "base64")
				: Buffer.from(entry.data, "utf8");
		if (entry.encoding === "base64" && data.toString("base64") !== entry.data)
			throw new Error("Vercel artifact requires canonical base64");
		bytes += data.length;
		if (bytes > 2_097_152)
			throw new Error("Vercel artifact exceeds its aggregate byte bound");
	}
	const root = input.rootDir ?? tmpdir();
	await mkdir(root, { recursive: true });
	const workDir = await mkdtemp(path.join(root, "hobo-vercel-drop-"));
	try {
		for (const entry of files) {
			const target = path.join(workDir, entry.file);
			await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
			await writeFile(
				target,
				entry.encoding === "base64"
					? Buffer.from(entry.data, "base64")
					: entry.data,
				{ flag: "wx", mode: 0o600 },
			);
		}
		return { workDir, files };
	} catch (error) {
		await rm(workDir, { recursive: true, force: true });
		throw error;
	}
}
export async function provisionTemporaryEnvironmentStation(
	input: VercelTemporaryStationInput,
): Promise<TemporaryEnvironmentStationResult> {
	if (!input.transport)
		throw new Error(
			"Vercel has no configured anonymous temporary API; account-backed CLI fallback is forbidden",
		);
	const projectName =
			input.projectName ?? sanitizeVercelDropProjectName(input.stationId),
		startedAt = Date.now();
	const { workDir, files } = await materializeVercelDropStation({
		stationId: input.stationId,
		...(input.files ? { files: input.files } : undefined),
	});
	try {
		const deployed = await input.transport.deployDrop({
			stationId: input.stationId,
			projectName,
			files,
			workDir,
		});
		const observedUrl = stationUrl(deployed.stationUrl),
			claim = new URL(deployed.claimUrl),
			expiry = Date.parse(deployed.expiresAt ?? "");
		if (
			claim.protocol !== "https:" ||
			claim.hostname !== "vercel.com" ||
			claim.username ||
			claim.password ||
			claim.port ||
			claim.pathname !== "/claim-deployment" ||
			!claim.searchParams.get("code")
		)
			throw new Error(
				"Vercel temporary transport lacks an observed ownership claim action",
			);
		if (
			deployed.anonymous !== true ||
			deployed.expirySource !== "provider-reported" ||
			!Number.isSafeInteger(expiry) ||
			expiry <= Date.now() ||
			expiry - startedAt > 86_400_000 ||
			new Date(expiry).toISOString() !== deployed.expiresAt
		)
			throw new Error(
				"Vercel temporary transport lacks provider-confirmed anonymous authority and bounded expiry",
			);
		if (deployed.projectName !== projectName)
			throw new Error(
				"Vercel temporary transport returned a different project scope",
			);
		if (!deployed.deploymentId)
			throw new Error(
				"Vercel temporary transport lacks a native deployment identity",
			);
		return {
			stationId: input.stationId,
			stationUrl: observedUrl,
			primaryUrl: observedUrl,
			claimUrl: deployed.claimUrl,
			expiresAt: new Date(expiry).toISOString(),
			ttlSeconds: Math.floor((expiry - startedAt) / 1000),
			providerId: VERCEL_TEMPORARY_PROVIDER_ID,
			scriptName: deployed.deploymentId,
			anonymous: true,
			temporary: true,
		};
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}
