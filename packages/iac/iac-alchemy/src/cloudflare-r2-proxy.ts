import { cancelCloudflareByteStream } from "./cloudflare-byte-stream.js";
/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: provider values cross the R2 boundary here. */
import {
	CLOUDFLARE_R2_MAX_OBJECT_BYTES,
	CloudflareR2Error,
	cloudflareR2Digest,
	decodeCloudflareR2ContentType,
	decodeCloudflareR2Key,
	encodeCloudflareR2ContentType,
	encodeCloudflareR2Key,
	readCloudflareR2Bytes,
	validCloudflareR2Digest,
	withCloudflareR2Deadline,
} from "./cloudflare-r2-protocol.js";
import {
	cloudflareHeaders,
	cloudflareR2PutOptions,
	cloudflareRequestBody,
	cloudflareRequestBodyUsed,
	cloudflareRequestHeader,
	cloudflareRequestMethod,
	cloudflareRequestUrl,
	cloudflareResponse,
} from "./cloudflare-web-options.js";

const applyCaptured = Reflect.apply;
const stringSlice = String.prototype.slice;
const NativeURL = URL;
const NativeString = String;

type NativeMetadata = {
	readonly key: string;
	readonly size: number;
	readonly httpMetadata?: { readonly contentType?: string };
	readonly customMetadata?: Record<string, string>;
};

export interface CloudflareR2ProxyEnvironment {
	readonly HOBO_R2_ALLOW: string;
	readonly HOBO_R2_BUCKET: {
		get(
			key: string,
		): Promise<
			(NativeMetadata & { readonly body: ReadableStream<Uint8Array> }) | null
		>;
		put(
			key: string,
			value: ArrayBuffer,
			options: {
				readonly httpMetadata: { readonly contentType: string };
				readonly customMetadata: Record<string, string>;
				readonly sha256: string;
			},
		): Promise<NativeMetadata | null>;
		delete(key: string): Promise<void>;
	};
}

function failure(code: string, status: number): Response {
	return cloudflareResponse(
		null,
		status,
		cloudflareHeaders("x-hobo-r2-error", code),
	);
}

function refuse(request: Request, code: string, status: number): Response {
	try {
		const body = cloudflareRequestBody(request);
		if (body !== null && !cloudflareRequestBodyUsed(request))
			cancelCloudflareByteStream(body);
	} catch {
		return failure(code, status);
	}
	return failure(code, status);
}

function size(input: string | null): number {
	if (input === null || !/^(0|[1-9][0-9]{0,6})$/u.test(input))
		throw new CloudflareR2Error("R2_OBJECT_INVALID", "invalid object size");
	const value = Number(input);
	if (value > CLOUDFLARE_R2_MAX_OBJECT_BYTES)
		throw new CloudflareR2Error(
			"R2_OBJECT_TOO_LARGE",
			"object exceeds the supported size",
		);
	return value;
}

function cancel(body: ReadableStream<Uint8Array>): void {
	cancelCloudflareByteStream(body);
}

export const cloudflareR2Proxy = {
	async fetch(
		request: Request,
		environment: CloudflareR2ProxyEnvironment,
	): Promise<Response> {
		const url = new NativeURL(cloudflareRequestUrl(request));
		if (
			cloudflareRequestMethod(request) !== "POST" ||
			url.origin !== "https://hobo-r2.internal"
		)
			return refuse(request, "R2_REQUEST_INVALID", 400);
		const operation = applyCaptured(stringSlice, url.pathname, [1]);
		const allow = environment.HOBO_R2_ALLOW;
		const permitted =
			(operation === "read" &&
				(allow === "read" ||
					allow === "delete,read" ||
					allow === "read,write" ||
					allow === "delete,read,write")) ||
			(operation === "write" &&
				(allow === "write" ||
					allow === "delete,write" ||
					allow === "read,write" ||
					allow === "delete,read,write")) ||
			(operation === "delete" &&
				(allow === "delete" ||
					allow === "delete,read" ||
					allow === "delete,write" ||
					allow === "delete,read,write"));
		if (!permitted) return refuse(request, "R2_OPERATION_DENIED", 403);
		let key: string;
		try {
			key = decodeCloudflareR2Key(
				cloudflareRequestHeader(request, "x-hobo-r2-key"),
			);
		} catch {
			return refuse(request, "R2_KEY_INVALID", 400);
		}
		const keyHeader = encodeCloudflareR2Key(key);
		if (operation !== "write" && cloudflareRequestBody(request) !== null)
			return refuse(request, "R2_REQUEST_INVALID", 400);
		try {
			if (operation === "read") {
				const result = await withCloudflareR2Deadline(
					() => environment.HOBO_R2_BUCKET.get(key),
					undefined,
					(late, lease) => {
						if (late === null) return "none";
						if (typeof late.body !== "object" || late.body === null)
							return "unavailable";
						return cancelCloudflareByteStream(late.body, lease);
					},
				);
				const object = result.value;
				if (object === null)
					return cloudflareResponse(
						null,
						404,
						cloudflareHeaders("x-hobo-r2-key", keyHeader),
					);
				const body = object.body;
				if (typeof body !== "object" || body === null)
					return failure("R2_READ_UNAVAILABLE", 502);
				if (
					object.key !== key ||
					!Number.isSafeInteger(object.size) ||
					object.size < 0
				) {
					cancel(body);
					return failure("R2_INTEGRITY_UNVERIFIED", 422);
				}
				if (object.size > CLOUDFLARE_R2_MAX_OBJECT_BYTES) {
					cancel(body);
					return failure("R2_OBJECT_TOO_LARGE", 413);
				}
				let contentType: string;
				try {
					contentType = encodeCloudflareR2ContentType(
						object.httpMetadata?.contentType ?? "",
					);
				} catch {
					cancel(body);
					return failure("R2_METADATA_UNSUPPORTED", 422);
				}
				const bytes = await readCloudflareR2Bytes(body);
				const digest = await cloudflareR2Digest(bytes);
				const storedDigest = object.customMetadata?.["hobo-sha256"];
				if (
					bytes.byteLength !== object.size ||
					(storedDigest !== undefined && storedDigest !== digest)
				)
					return failure("R2_INTEGRITY_UNVERIFIED", 422);
				const headers = cloudflareHeaders("x-hobo-r2-key", keyHeader);
				headers["x-hobo-r2-content-type"] = contentType;
				headers["x-hobo-r2-size"] = NativeString(bytes.byteLength);
				headers["x-hobo-r2-digest"] = digest;
				return cloudflareResponse(bytes, 200, headers);
			}
			if (operation === "delete") {
				await withCloudflareR2Deadline(() =>
					environment.HOBO_R2_BUCKET.delete(key),
				);
				return cloudflareResponse(
					null,
					204,
					cloudflareHeaders("x-hobo-r2-key", keyHeader),
				);
			}
			const contentType = decodeCloudflareR2ContentType(
				cloudflareRequestHeader(request, "x-hobo-r2-content-type"),
			);
			const expectedSize = size(
				cloudflareRequestHeader(request, "x-hobo-r2-size"),
			);
			const digest = cloudflareRequestHeader(request, "x-hobo-r2-digest");
			if (digest === null || !validCloudflareR2Digest(digest))
				return refuse(request, "R2_OBJECT_INVALID", 400);
			const bytes = await readCloudflareR2Bytes(cloudflareRequestBody(request));
			if (
				bytes.byteLength !== expectedSize ||
				(await cloudflareR2Digest(bytes)) !== digest
			)
				return failure("R2_INTEGRITY_UNVERIFIED", 422);
			const result = await withCloudflareR2Deadline(() =>
				environment.HOBO_R2_BUCKET.put(
					key,
					bytes,
					cloudflareR2PutOptions(
						contentType,
						applyCaptured(stringSlice, digest, [7]),
					),
				),
			);
			const object = result.value;
			if (
				object === null ||
				object.key !== key ||
				object.size !== bytes.byteLength ||
				object.httpMetadata?.contentType !== contentType ||
				object.customMetadata?.["hobo-sha256"] !== digest
			)
				return failure("R2_MUTATION_OUTCOME_UNKNOWN", 502);
			const headers = cloudflareHeaders("x-hobo-r2-key", keyHeader);
			headers["x-hobo-r2-content-type"] =
				encodeCloudflareR2ContentType(contentType);
			headers["x-hobo-r2-size"] = NativeString(bytes.byteLength);
			headers["x-hobo-r2-digest"] = digest;
			return cloudflareResponse(null, 204, headers);
		} catch (error) {
			if (error instanceof CloudflareR2Error)
				return refuse(request, error.code, 422);
			return refuse(
				request,
				operation === "read"
					? "R2_READ_UNAVAILABLE"
					: "R2_MUTATION_OUTCOME_UNKNOWN",
				502,
			);
		}
	},
};
export default cloudflareR2Proxy;
