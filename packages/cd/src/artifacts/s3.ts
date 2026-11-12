// S3-compatible backend over the injected `HttpTransport`, signed with SigV4
// from `@hobo/core/aws-sigv4`. Path-style addressing (`<endpoint>/<bucket>/<key>`)
// so AWS, R2, MinIO, Spaces, Hetzner and Ceph all work without DNS tricks.
//
// - Credentials are resolved per call from `credentialRef` and live only in
//   the signing call: they never reach an event, a metric or an error.
// - Creates are conditional (`If-None-Match: *`), so two writers racing on one
//   digest cannot both "create" it.
// - Above `ARTIFACT_MULTIPART_THRESHOLD_BYTES` the upload is multipart and is
//   aborted on any failure: S3 never exposes an object before
//   CompleteMultipartUpload, so a partial upload is never visible.
// - `HttpTransport` bodies are text (core `TransportRequest.body: string`), so
//   objects are stored base64-encoded with `x-amz-meta-hobo-encoding: base64`
//   and decoded on read; the digest is always over the decoded bytes.

import type {
	TransportMethod,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import { type AwsCredentials, signAwsRequest } from "@hobo/core/aws-sigv4";
import type { ArtifactStoreConfig, Digest } from "../ports.js";
import type { BlobBackend, BlobMeta, WriteOutcome } from "./backend.js";
import {
	decodeBase64,
	digestHex,
	encodeBase64,
	parseDigest,
} from "./digest.js";
import { errorCodeOf } from "./json.js";
import { ARTIFACT_REASON, ArtifactStoreError } from "./reasons.js";

// public-contract: raw size above which an S3 upload is multipart (64 MiB).
export const ARTIFACT_MULTIPART_THRESHOLD_BYTES = 67_108_864;
// public-contract: largest blob the S3 backend stores (256 MiB raw); base64 text
// of anything larger would exceed what a text transport can carry.
export const ARTIFACT_S3_MAX_BLOB_BYTES = 268_435_456;
// public-contract: object key prefix of content-addressed blobs.
export const ARTIFACT_S3_KEY_PREFIX = "blobs/sha256/";

const CONTROL_TIMEOUT_MS = 30_000;
const OBJECT_TIMEOUT_MS = 120_000;
const CONTROL_MAX_RESPONSE_BYTES = 1_048_576;

export type S3Config = Extract<
	ArtifactStoreConfig,
	{ backend: "s3-compatible" }
>;

/** Test seam: the multipart threshold and part size, in raw bytes / encoded chars. */
export type S3Tuning = Readonly<{
	multipartThresholdBytes: number;
	partSizeChars: number;
	maxBlobBytes: number;
}>;

const DEFAULT_TUNING: S3Tuning = {
	multipartThresholdBytes: ARTIFACT_MULTIPART_THRESHOLD_BYTES,
	partSizeChars: ARTIFACT_MULTIPART_THRESHOLD_BYTES,
	maxBlobBytes: ARTIFACT_S3_MAX_BLOB_BYTES,
};

function rfc3986(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function xmlDecode(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function xmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function xmlValues(xml: string, tag: string): string[] {
	const values: string[] = [];
	const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
	for (const match of xml.matchAll(pattern))
		values.push(xmlDecode(match[1] ?? ""));
	return values;
}

/** Sign one S3 request with SigV4; exposed so the AWS published vectors can pin it. */
export function signS3Request(
	input: Readonly<{
		method: TransportMethod;
		url: string;
		headers: Readonly<Record<string, string>>;
		body?: string;
		region: string;
		credentials: AwsCredentials;
		now: Date;
	}>,
) {
	const request = {
		method: input.method,
		url: input.url,
		headers: input.headers,
		region: input.region,
		service: "s3",
		credentials: input.credentials,
		now: input.now,
	};
	return signAwsRequest(
		input.body === undefined ? request : { ...request, body: input.body },
	);
}

export function parseS3Config(config: S3Config): S3Config {
	let url: URL;
	try {
		url = new URL(config.endpoint);
	} catch {
		throw configInvalid("endpoint is not a URL");
	}
	if (url.protocol !== "https:") throw configInvalid("endpoint must use https");
	if (url.username !== "" || url.password !== "")
		throw configInvalid(
			"endpoint must not embed credentials; use credentialRef",
		);
	if (url.search !== "" || url.hash !== "")
		throw configInvalid("endpoint must not carry a query or fragment");
	if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket))
		throw configInvalid("bucket must be a DNS-compatible S3 bucket name");
	if (!/^[a-z0-9-]{1,32}$/.test(config.region))
		throw configInvalid(
			"region must be an S3 region identifier such as us-east-1",
		);
	if (config.credentialRef.trim() === "")
		throw configInvalid("credentialRef is required");
	return config;
}

function configInvalid(detail: string): ArtifactStoreError {
	return new ArtifactStoreError(
		ARTIFACT_REASON.configInvalid,
		`s3-compatible artifact store config: ${detail}`,
		"Fix the s3-compatible store config (https endpoint, DNS-compatible bucket, region, credentialRef) and restart the CD service.",
	);
}

function credentialsFrom(
	resolved: Readonly<Record<string, string>>,
): AwsCredentials | undefined {
	const accessKeyId = resolved.accessKeyId ?? resolved.AWS_ACCESS_KEY_ID;
	const secretAccessKey =
		resolved.secretAccessKey ?? resolved.AWS_SECRET_ACCESS_KEY;
	const sessionToken = resolved.sessionToken ?? resolved.AWS_SESSION_TOKEN;
	if (!accessKeyId || !secretAccessKey) return undefined;
	return sessionToken
		? { accessKeyId, secretAccessKey, sessionToken }
		: { accessKeyId, secretAccessKey };
}

function transportFailure<E>(operation: string, error: E): ArtifactStoreError {
	const code = errorCodeOf(error);
	return new ArtifactStoreError(
		ARTIFACT_REASON.backendUnavailable,
		`s3 ${operation} did not complete (${code}); its outcome is unknown`,
		"Retry: every store operation is idempotent by digest. If it persists, check the endpoint's reachability from the CD service.",
	);
}

function statusFailure(operation: string, status: number): ArtifactStoreError {
	if (status === 401 || status === 403)
		return new ArtifactStoreError(
			ARTIFACT_REASON.backendRejected,
			`s3 ${operation} was refused (HTTP ${status})`,
			"Grant the credential behind credentialRef s3:GetObject, s3:PutObject, s3:DeleteObject, s3:ListBucket and multipart permissions on the bucket, or rotate it if it expired.",
		);
	return new ArtifactStoreError(
		ARTIFACT_REASON.backendUnavailable,
		`s3 ${operation} failed (HTTP ${status})`,
		"Retry: every store operation is idempotent by digest. Check the object store's health if it persists.",
	);
}

export function createS3Backend(
	input: S3Config,
	now: () => number,
	tuning: S3Tuning = DEFAULT_TUNING,
): BlobBackend {
	const config = parseS3Config(input);
	const base = config.endpoint.replace(/\/+$/, "");

	async function credentials(): Promise<AwsCredentials> {
		let resolved: Readonly<Record<string, string>>;
		try {
			resolved = await config.credentials.resolve(
				config.credentialRef,
				`artifact-store:s3:${config.bucket}`,
			);
		} catch {
			throw unresolvable();
		}
		const parsed = credentialsFrom(resolved);
		if (parsed === undefined) throw unresolvable();
		return parsed;
	}

	function unresolvable(): ArtifactStoreError {
		return new ArtifactStoreError(
			ARTIFACT_REASON.credentialUnavailable,
			`credentialRef ${config.credentialRef} did not resolve to an access key pair`,
			"Make the credential resolver return accessKeyId and secretAccessKey (and sessionToken for temporary credentials) for this credentialRef.",
		);
	}

	async function send(
		request: Readonly<{
			operation: string;
			method: TransportMethod;
			key?: string;
			query?: readonly (readonly [string, string])[];
			headers?: Readonly<Record<string, string>>;
			body?: string;
			timeoutMs: number;
			maxResponseBytes: number;
		}>,
	): Promise<TransportResponse> {
		const path =
			request.key === undefined
				? `/${config.bucket}`
				: `/${config.bucket}/${request.key.split("/").map(rfc3986).join("/")}`;
		const query = (request.query ?? [])
			.map(([name, value]) => `${rfc3986(name)}=${rfc3986(value)}`)
			.join("&");
		const url = `${base}${path}${query === "" ? "" : `?${query}`}`;
		const unsigned = {
			method: request.method,
			url,
			headers: request.headers ?? {},
			region: config.region,
			credentials: await credentials(),
			now: new Date(now()),
		};
		const signed = signS3Request(
			request.body === undefined
				? unsigned
				: { ...unsigned, body: request.body },
		);
		const { host: _host, ...headers } = signed.headers;
		const outgoing: TransportRequest = {
			method: request.method,
			url,
			headers,
			timeoutMs: request.timeoutMs,
			maxResponseBytes: request.maxResponseBytes,
		};
		try {
			return await config.http(
				request.body === undefined
					? outgoing
					: { ...outgoing, body: request.body },
			);
		} catch (error) {
			throw transportFailure(request.operation, error);
		}
	}

	const keyOf = (digest: Digest) =>
		`${ARTIFACT_S3_KEY_PREFIX}${digestHex(digest)}`;

	function objectHeaders(digest: Digest, meta: BlobMeta) {
		return {
			"content-type": "text/plain; charset=utf-8",
			"x-amz-meta-hobo-encoding": "base64",
			"x-amz-meta-hobo-digest": digest,
			"x-amz-meta-hobo-size": String(meta.sizeBytes),
			"x-amz-meta-hobo-media-type": meta.mediaType.replace(/[^\x20-\x7e]/g, ""),
		};
	}

	async function putSingle(
		digest: Digest,
		text: string,
		meta: BlobMeta,
		replace: boolean,
	): Promise<WriteOutcome> {
		const headers = objectHeaders(digest, meta);
		const response = await send({
			operation: "put",
			method: "PUT",
			key: keyOf(digest),
			headers: replace ? headers : { ...headers, "if-none-match": "*" },
			body: text,
			timeoutMs: OBJECT_TIMEOUT_MS,
			maxResponseBytes: CONTROL_MAX_RESPONSE_BYTES,
		});
		if (response.status === 412 || response.status === 409) return "exists";
		if (response.status < 200 || response.status > 299)
			throw statusFailure("put", response.status);
		return "created";
	}

	async function abort(digest: Digest, uploadId: string): Promise<void> {
		await send({
			operation: "abort-multipart",
			method: "DELETE",
			key: keyOf(digest),
			query: [["uploadId", uploadId]],
			timeoutMs: CONTROL_TIMEOUT_MS,
			maxResponseBytes: CONTROL_MAX_RESPONSE_BYTES,
		}).catch(() => undefined);
	}

	async function putMultipart(
		digest: Digest,
		text: string,
		meta: BlobMeta,
		replace: boolean,
	): Promise<WriteOutcome> {
		const created = await send({
			operation: "create-multipart",
			method: "POST",
			key: keyOf(digest),
			query: [["uploads", ""]],
			headers: objectHeaders(digest, meta),
			timeoutMs: CONTROL_TIMEOUT_MS,
			maxResponseBytes: CONTROL_MAX_RESPONSE_BYTES,
		});
		if (created.status < 200 || created.status > 299)
			throw statusFailure("create-multipart", created.status);
		const uploadId = xmlValues(created.body, "UploadId")[0];
		if (uploadId === undefined || uploadId === "")
			throw statusFailure("create-multipart", created.status);
		try {
			const parts: { number: number; etag: string }[] = [];
			for (
				let offset = 0, number = 1;
				offset < text.length;
				offset += tuning.partSizeChars, number += 1
			) {
				const part = await send({
					operation: "upload-part",
					method: "PUT",
					key: keyOf(digest),
					query: [
						["partNumber", String(number)],
						["uploadId", uploadId],
					],
					body: text.slice(offset, offset + tuning.partSizeChars),
					timeoutMs: OBJECT_TIMEOUT_MS,
					maxResponseBytes: CONTROL_MAX_RESPONSE_BYTES,
				});
				const etag = part.headers.etag;
				if (part.status < 200 || part.status > 299 || etag === undefined)
					throw statusFailure("upload-part", part.status);
				parts.push({ number, etag });
			}
			const manifest = `<CompleteMultipartUpload>${parts
				.map(
					(part) =>
						`<Part><PartNumber>${part.number}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`,
				)
				.join("")}</CompleteMultipartUpload>`;
			const completed = await send({
				operation: "complete-multipart",
				method: "POST",
				key: keyOf(digest),
				query: [["uploadId", uploadId]],
				headers: replace
					? { "content-type": "application/xml" }
					: { "content-type": "application/xml", "if-none-match": "*" },
				body: manifest,
				timeoutMs: OBJECT_TIMEOUT_MS,
				maxResponseBytes: CONTROL_MAX_RESPONSE_BYTES,
			});
			if (completed.status === 412 || completed.status === 409) {
				await abort(digest, uploadId);
				return "exists";
			}
			// S3 can answer 200 and still report an <Error> in the body.
			if (
				completed.status < 200 ||
				completed.status > 299 ||
				/<Error>/.test(completed.body)
			)
				throw statusFailure("complete-multipart", completed.status);
			return "created";
		} catch (error) {
			await abort(digest, uploadId);
			throw error;
		}
	}

	return {
		name: "s3-compatible",
		maxBlobBytes: tuning.maxBlobBytes,
		async write(digest, bytes, meta, options): Promise<WriteOutcome> {
			const text = encodeBase64(bytes);
			return bytes.byteLength > tuning.multipartThresholdBytes
				? putMultipart(digest, text, meta, options.replace)
				: putSingle(digest, text, meta, options.replace);
		},
		async read(digest) {
			const response = await send({
				operation: "get",
				method: "GET",
				key: keyOf(digest),
				timeoutMs: OBJECT_TIMEOUT_MS,
				maxResponseBytes: Math.ceil((tuning.maxBlobBytes * 4) / 3) + 65_536,
			});
			if (response.status === 404) return undefined;
			if (response.status < 200 || response.status > 299)
				throw statusFailure("get", response.status);
			const encoding = response.headers["x-amz-meta-hobo-encoding"];
			if (encoding !== undefined && encoding !== "base64")
				return new TextEncoder().encode(response.body);
			// Undecodable text cannot hash to the digest; the store reports it as corrupt.
			return (
				decodeBase64(response.body) ?? new TextEncoder().encode(response.body)
			);
		},
		async exists(digest) {
			const response = await send({
				operation: "head",
				method: "HEAD",
				key: keyOf(digest),
				timeoutMs: CONTROL_TIMEOUT_MS,
				maxResponseBytes: CONTROL_MAX_RESPONSE_BYTES,
			});
			if (response.status === 404) return false;
			if (response.status < 200 || response.status > 299)
				throw statusFailure("head", response.status);
			return true;
		},
		async *keys(signal: AbortSignal) {
			let token: string | undefined;
			do {
				if (signal.aborted) return;
				const query: [string, string][] = [
					["list-type", "2"],
					["prefix", ARTIFACT_S3_KEY_PREFIX],
				];
				if (token !== undefined) query.push(["continuation-token", token]);
				const response = await send({
					operation: "list",
					method: "GET",
					query,
					timeoutMs: CONTROL_TIMEOUT_MS,
					maxResponseBytes: 16 * CONTROL_MAX_RESPONSE_BYTES,
				});
				if (response.status < 200 || response.status > 299)
					throw statusFailure("list", response.status);
				for (const key of xmlValues(response.body, "Key")) {
					if (signal.aborted) return;
					if (!key.startsWith(ARTIFACT_S3_KEY_PREFIX)) continue;
					const digest = parseDigest(
						`sha256:${key.slice(ARTIFACT_S3_KEY_PREFIX.length)}`,
					);
					if (digest !== undefined) yield digest;
				}
				const truncated = xmlValues(response.body, "IsTruncated")[0] === "true";
				token = truncated
					? xmlValues(response.body, "NextContinuationToken")[0]
					: undefined;
			} while (token !== undefined && token !== "");
		},
		async remove(digest) {
			const response = await send({
				operation: "delete",
				method: "DELETE",
				key: keyOf(digest),
				timeoutMs: CONTROL_TIMEOUT_MS,
				maxResponseBytes: CONTROL_MAX_RESPONSE_BYTES,
			});
			if (response.status === 404) return;
			if (response.status < 200 || response.status > 299)
				throw statusFailure("delete", response.status);
		},
	};
}
