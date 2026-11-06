import { createSign } from "node:crypto";
import { z } from "zod";
import { publicKeySha256Base64 } from "./bootstrap-crypto.mts";
import { APP_ID, REPOSITORY, REPOSITORY_ID } from "./protocol.mts";

const EXPECTED_KEY = "KoX0tc1LHhyCxZ+2WiuvFbgvpupKcCJSsJ3bCdyfMyA=";
const HEADERS = {
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2026-03-10",
};
const permissions = z.object({
	actions: z.string(),
	administration: z.string(),
});
const appResponse = z.object({
	id: z.number().int(),
	slug: z.string(),
	owner: z.object({ login: z.string() }),
	permissions,
});
const installationResponse = z.object({
	id: z.number().int().positive(),
	app_id: z.number().int(),
	account: z.object({ login: z.string() }),
	suspended_at: z.string().nullable(),
	permissions,
});
const tokenResponse = z.object({
	token: z.string().min(1),
	expires_at: z.string(),
});
const repositoryResponse = z.object({
	id: z.number().int(),
	private: z.boolean(),
	full_name: z.string(),
});
const runnersResponse = z.object({
	runners: z.array(z.object({}).passthrough()),
	total_count: z.number().int().nonnegative(),
});
function jwt(key: string | Buffer, now: number): string {
	const issued = Math.floor(now / 1000) - 60;
	const a = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString(
			"base64url",
		),
		b = Buffer.from(
			JSON.stringify({ iat: issued, exp: issued + 600, iss: APP_ID }),
		).toString("base64url"),
		value = `${a}.${b}`;
	return `${value}.${createSign("RSA-SHA256").update(value).sign(key).toString("base64url")}`;
}
async function json<T extends z.ZodType>(
	response: Response,
	schema: T,
): Promise<z.output<T>> {
	if (!response.ok) throw new Error("App verification failed");
	if (
		!response.body ||
		Number(response.headers.get("content-length")) > 1024 * 1024
	)
		throw new Error("App verification failed");
	const reader = response.body.getReader();
	const parts: Buffer[] = [];
	let length = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			length += part.value.byteLength;
			if (length > 1024 * 1024) {
				await reader.cancel();
				throw new Error("App verification failed");
			}
			parts.push(Buffer.from(part.value));
		}
	} finally {
		reader.releaseLock();
	}
	return schema.parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
}
/** Verifies App and repository authority with a scoped token that is never written or returned. */
export async function verifyGithubApp({
	appPrivateKey,
	fetchImpl = fetch,
	now = Date.now(),
	expectedFingerprint = EXPECTED_KEY,
}: {
	appPrivateKey: string | Buffer;
	fetchImpl?: typeof fetch;
	now?: number;
	expectedFingerprint?: string;
}) {
	if (publicKeySha256Base64(appPrivateKey) !== expectedFingerprint)
		throw new Error("App key fingerprint mismatch");
	const headers = {
		...HEADERS,
		Authorization: `Bearer ${jwt(appPrivateKey, now)}`,
	};
	const app = await json(
		await fetchImpl("https://api.github.com/app", {
			method: "GET",
			headers,
			redirect: "error",
			signal: AbortSignal.timeout(15000),
		}),
		appResponse,
	);
	if (
		app.id !== APP_ID ||
		app.slug !== "hobo-ci-runner-b61dd084" ||
		app.owner?.login !== "Hobo-Labs" ||
		app.permissions?.actions !== "write" ||
		app.permissions?.administration !== "write"
	)
		throw new Error("App identity or permissions mismatch");
	const installation = await json(
		await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/installation`, {
			method: "GET",
			headers,
			redirect: "error",
			signal: AbortSignal.timeout(15000),
		}),
		installationResponse,
	);
	if (
		!Number.isSafeInteger(installation.id) ||
		installation.id <= 0 ||
		installation.app_id !== APP_ID ||
		installation.account?.login !== "Hobo-Labs" ||
		installation.suspended_at !== null ||
		installation.permissions?.actions !== "write" ||
		installation.permissions?.administration !== "write"
	)
		throw new Error("App installation mismatch");
	const minted = await json(
		await fetchImpl(
			`https://api.github.com/app/installations/${installation.id}/access_tokens`,
			{
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({
					repository_ids: [REPOSITORY_ID],
					permissions: {
						actions: "write",
						administration: "write",
						contents: "read",
						metadata: "read",
					},
				}),
				redirect: "error",
				signal: AbortSignal.timeout(15000),
			},
		),
		tokenResponse,
	);
	if (!Number.isFinite(Date.parse(minted.expires_at)))
		throw new Error("App token verification failed");
	const repository = await json(
		await fetchImpl(`https://api.github.com/repos/${REPOSITORY}`, {
			method: "GET",
			headers: { ...HEADERS, Authorization: `Bearer ${minted.token}` },
			redirect: "error",
			signal: AbortSignal.timeout(15000),
		}),
		repositoryResponse,
	);
	if (
		repository.id !== REPOSITORY_ID ||
		repository.private !== false ||
		repository.full_name.toLowerCase() !== REPOSITORY.toLowerCase()
	)
		throw new Error("repository identity or visibility mismatch");
	const runners = await json(
		await fetchImpl(
			`https://api.github.com/repos/${REPOSITORY}/actions/runners?per_page=1`,
			{
				method: "GET",
				headers: { ...HEADERS, Authorization: `Bearer ${minted.token}` },
				redirect: "error",
				signal: AbortSignal.timeout(15000),
			},
		),
		runnersResponse,
	);
	if (!Number.isSafeInteger(runners.total_count) || runners.total_count < 0)
		throw new Error("runner access verification failed");
	return {
		installationId: installation.id,
		appId: APP_ID,
		appSlug: app.slug,
		installationAccount: installation.account.login,
	};
}
