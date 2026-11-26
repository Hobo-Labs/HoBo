/**
 * Legacy same-origin anonymous host helpers (residual).
 * OOB Examples yards use Temporary Accounts / Drop / provider-temp APIs instead.
 * Railway removed from OOB; Vercel uses Drop (`/api/vercel-temp`).
 */
import { mkdir, readFile, writeFile, cp, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const HOST_ROOT = path.join(REPO_ROOT, "site/.hobo-anon-hosts");
const OPENSAAS_BUILD = path.join(
	REPO_ROOT,
	"examples/wasp-opensaas/app/.wasp/out/web-app/build",
);

export type AnonProviderId = string;

export type AnonHostResult = {
	readonly ok: true;
	readonly providerId: AnonProviderId;
	readonly stationId: string;
	readonly endpointUrl: string;
	readonly claimUrl: string;
	readonly expiresAt: string;
	readonly anonymous: true;
	readonly temporary: true;
	readonly hostKind: "same-origin-agent";
};

function hostIdFor(providerId: string, stationId: string): string {
	const raw = `${providerId}-${stationId}`;
	const suffix = createHash("sha256").update(raw).digest("hex").slice(0, 12);
	return `${raw
		.replace(/[^a-z0-9-]+/giu, "-")
		.toLowerCase()
		.slice(0, 64)}-${suffix}`;
}

const metadataFile = (dir: string) => path.join(dir, ".hobo-host.json");

async function writeHostMetadata(dir: string, expiresAt: string): Promise<void> {
	await writeFile(metadataFile(dir), JSON.stringify({ expiresAt }), "utf8");
}

export async function provisionSameOriginAnonStation(input: {
	readonly providerId: AnonProviderId;
	readonly stationId: string;
	readonly origin: string;
	readonly basePath?: string;
}): Promise<AnonHostResult> {
	const base = (input.basePath ?? "/HoBo").replace(/\/$/u, "");
	const hostId = hostIdFor(input.providerId, input.stationId);
	const dir = path.join(HOST_ROOT, hostId);
	await mkdir(dir, { recursive: true });
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>${input.providerId} agent host</title></head>
<body data-hobo-station="${input.providerId}">
<p>${input.providerId} same-origin agent Environment Station (legacy helper).</p>
</body></html>`;
	await writeFile(path.join(dir, "index.html"), html, "utf8");
	const endpointUrl = `${input.origin}${base}/api/anon/host/${hostId}/`;
	const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
	await writeHostMetadata(dir, expiresAt);
	return {
		ok: true,
		providerId: input.providerId,
		stationId: input.stationId,
		endpointUrl,
		claimUrl: `${endpointUrl}#claim`,
		expiresAt,
		anonymous: true,
		temporary: true,
		hostKind: "same-origin-agent",
	};
}

export async function shipOpenSaasSameOrigin(input: {
	readonly providerId: AnonProviderId;
	readonly stationId: string;
	readonly origin: string;
	readonly basePath?: string;
}): Promise<{
	readonly ok: true;
	readonly exampleId: string;
	readonly clientUrl: string;
	readonly serverUrl: string;
	readonly claimUrl: string;
	readonly expiresAt: string;
	readonly anonymous: true;
	readonly temporary: true;
	readonly hostKind: "same-origin-agent";
	readonly providerId: string;
}> {
	const base = (input.basePath ?? "/HoBo").replace(/\/$/u, "");
	const hostId = hostIdFor(input.providerId, `${input.stationId}-opensaas`);
	const dir = path.join(HOST_ROOT, hostId);
	await mkdir(dir, { recursive: true });
	try {
		await access(OPENSAAS_BUILD);
		await cp(OPENSAAS_BUILD, dir, { recursive: true });
	} catch {
		await writeFile(
			path.join(dir, "index.html"),
			`<!doctype html><html><body data-hobo-station="${input.providerId}"><p>OpenSaaS stub</p></body></html>`,
			"utf8",
		);
	}
	const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
	await writeHostMetadata(dir, expiresAt);
	const clientUrl = `${input.origin}${base}/api/anon/host/${hostId}/`;
	return {
		ok: true,
		exampleId: "opensaas",
		clientUrl,
		serverUrl: clientUrl,
		claimUrl: `${clientUrl}#claim`,
		expiresAt,
		anonymous: true,
		temporary: true,
		hostKind: "same-origin-agent",
		providerId: input.providerId,
	};
}

export async function serveAnonHostFile(
	hostId: string,
	relPath: string,
): Promise<{ status: number; contentType: string; body: Buffer } | null> {
	if (!/^[a-z0-9-]{1,128}$/u.test(hostId)) return null;
	const safe = relPath.replace(/\.\./gu, "").replace(/^\/+/u, "") || "index.html";
	const hostDirectory = path.join(HOST_ROOT, hostId);
	try {
		// SAFETY: assertion required at this I/O boundary.
		const metadata = JSON.parse(await readFile(metadataFile(hostDirectory), "utf8")) as {
			expiresAt?: unknown;
		};
		if (Object.prototype.toString.call(metadata.expiresAt) !== "[object String]" || Date.parse(metadata.expiresAt) <= Date.now()) return null;
		const filePath = path.join(hostDirectory, safe);
		const body = await readFile(filePath);
		const contentType = safe.endsWith(".html")
			? "text/html; charset=utf-8"
			: "application/octet-stream";
		return { status: 200, contentType, body };
	} catch {
		return null;
	}
}
