/**
 * Direct, private R2 object operations needed for compare-and-set state.
 *
 * The origin is constructed from the independently verified Cloudflare account
 * and jurisdiction. Public URLs and caches are never used. R2 serializes
 * conditional PutObject operations at the origin; reads from that origin are
 * strongly consistent. A failed request may still have committed, so transport
 * errors never become an affirmative success or an ordinary CAS conflict.
 *
 * https://developers.cloudflare.com/r2/api/s3/conditional-operations/
 * https://developers.cloudflare.com/r2/reference/consistency/
 */
import { guardTransport, type HttpTransport } from "@hobo/core";
import { type AwsCredentials, signAwsRequest } from "@hobo/core/aws-sigv4";

export type R2ObjectOptions = Readonly<{
	accountId: string;
	bucket: string;
	jurisdiction?: "eu" | "fedramp" | "us";
	resolveCredentials(): Promise<AwsCredentials>;
	transport: HttpTransport;
	now(): number;
	maxObjectBytes: number;
	timeoutMs?: number;
}>;

export type R2Object = Readonly<{ body: string; etag: string }>;
export type R2Condition =
	| Readonly<{ kind: "absent" }>
	| Readonly<{ kind: "match"; etag: string }>;

export class R2ObjectError extends Error {
	constructor(
		readonly reason: string,
		readonly status?: number,
	) {
		super(
			`Cloudflare R2 object operation failed (${reason}${status === undefined ? "" : `, HTTP ${status}`})`,
		);
		this.name = "R2ObjectError";
	}
}

function strongEtag(value: string | undefined): string {
	if (
		value === undefined ||
		value.length < 3 ||
		value.length > 256 ||
		!/^"[\x21\x23-\x7e]+"$/u.test(value)
	)
		throw new R2ObjectError("invalid-etag");
	return value;
}

function header(
	headers: Readonly<Record<string, string>>,
	name: string,
): string | undefined {
	return Object.entries(headers).find(
		([key]) => key.toLowerCase() === name,
	)?.[1];
}

/** Creates an R2-only origin client. It has no unconditional write or delete. */
export function createR2ObjectClient(options: R2ObjectOptions) {
	if (!/^[a-f0-9]{32}$/u.test(options.accountId))
		throw new R2ObjectError("invalid-account");
	if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(options.bucket))
		throw new R2ObjectError("invalid-bucket");
	if (
		options.jurisdiction !== undefined &&
		!["eu", "fedramp", "us"].includes(options.jurisdiction)
	)
		throw new R2ObjectError("invalid-jurisdiction");
	if (
		!Number.isSafeInteger(options.maxObjectBytes) ||
		options.maxObjectBytes < 1024 ||
		options.maxObjectBytes > 8 * 1024 * 1024
	)
		throw new R2ObjectError("invalid-capacity");
	const timeoutMs = options.timeoutMs ?? 15_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
		throw new R2ObjectError("invalid-timeout");
	const host = `${options.accountId}${options.jurisdiction ? `.${options.jurisdiction}` : ""}.r2.cloudflarestorage.com`;
	const prefix = `/${options.bucket}/`;
	const maxObjectBytes = options.maxObjectBytes;
	const now = options.now;
	const resolveCredentials = options.resolveCredentials;
	const transport = guardTransport(options.transport, {
		allowedHosts: [host],
		allowedPathPrefixes: [prefix],
		maxTimeoutMs: timeoutMs,
		maxResponseBytes: maxObjectBytes,
	});

	function urlFor(key: string): string {
		// Callers encode application keys before this boundary. Refusing dot
		// segments and percent escapes keeps both the guard and signer unambiguous.
		if (
			key.length < 1 ||
			key.length > 950 ||
			!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(key)
		)
			throw new R2ObjectError("invalid-object-key");
		return `https://${host}${prefix}${key}`;
	}
	async function request(
		method: "GET" | "PUT",
		key: string,
		body?: string,
		condition?: R2Condition,
	) {
		const url = urlFor(key);
		if (body !== undefined && Buffer.byteLength(body, "utf8") > maxObjectBytes)
			throw new R2ObjectError("object-too-large");
		const at = now();
		if (!Number.isSafeInteger(at) || at < 0)
			throw new R2ObjectError("invalid-clock");
		let credentials: AwsCredentials;
		try {
			credentials = await resolveCredentials();
		} catch {
			throw new R2ObjectError("credential-unavailable");
		}
		const conditional =
			condition?.kind === "absent"
				? { "if-none-match": "*" }
				: condition?.kind === "match"
					? { "if-match": strongEtag(condition.etag) }
					: {};
		const signed = signAwsRequest({
			method,
			url,
			...(body === undefined ? undefined : { body }),
			region: "auto",
			service: "s3",
			credentials,
			now: new Date(at),
			headers: {
				...conditional,
				...(body === undefined
					? undefined
					: { "content-type": "application/json" }),
			},
		});
		try {
			return await transport({
				method,
				url,
				headers: signed.headers,
				...(body === undefined ? undefined : { body }),
				timeoutMs,
				maxResponseBytes: maxObjectBytes,
			});
		} catch {
			// Do not leak signed headers, provider bodies, or credential material.
			throw new R2ObjectError(
				method === "PUT" ? "write-outcome-unknown" : "read-unavailable",
			);
		}
	}
	return Object.freeze({
		async get(key: string): Promise<R2Object | undefined> {
			const result = await request("GET", key);
			if (result.status === 404) return undefined;
			if (result.status !== 200)
				throw new R2ObjectError("read-rejected", result.status);
			return {
				body: result.body,
				etag: strongEtag(header(result.headers, "etag")),
			};
		},
		async put(
			key: string,
			body: string,
			condition: R2Condition,
		): Promise<{ applied: boolean; etag?: string }> {
			if (
				!condition ||
				(condition.kind !== "absent" && condition.kind !== "match")
			)
				throw new R2ObjectError("condition-required");
			const result = await request("PUT", key, body, condition);
			if (result.status === 412) return { applied: false };
			if (result.status !== 200)
				throw new R2ObjectError("write-outcome-unknown", result.status);
			return {
				applied: true,
				etag: strongEtag(header(result.headers, "etag")),
			};
		},
	});
}
