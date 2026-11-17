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
} from "./cloudflare-r2-protocol.js";

type NativeMetadata = {
	readonly key: string;
	readonly size: number;
	readonly httpMetadata?: { readonly contentType?: string };
	readonly customMetadata?: Record<string, string>;
};

/** The app holds a service binding; this private Worker alone holds the R2 binding. */
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
	return new Response(null, { status, headers: { "x-hobo-r2-error": code } });
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
	void body.cancel().catch(() => {});
}

export const cloudflareR2Proxy = {
	async fetch(
		request: Request,
		environment: CloudflareR2ProxyEnvironment,
	): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.origin !== "https://hobo-r2.internal")
			return failure("R2_REQUEST_INVALID", 400);
		const operation = url.pathname.slice(1);
		const allow = environment.HOBO_R2_ALLOW;
		if (
			/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: the deployed environment is an external boundary. */
			typeof allow !== "string" ||
			![
				"delete",
				"read",
				"write",
				"delete,read",
				"delete,write",
				"read,write",
				"delete,read,write",
			].includes(allow) ||
			!["read", "write", "delete"].includes(operation) ||
			!allow.split(",").includes(operation)
		)
			return failure("R2_OPERATION_DENIED", 403);
		let key: string;
		try {
			key = decodeCloudflareR2Key(request.headers.get("x-hobo-r2-key"));
		} catch {
			return failure("R2_KEY_INVALID", 400);
		}
		const keyHeader = encodeCloudflareR2Key(key);
		try {
			if (operation === "read") {
				const object = await environment.HOBO_R2_BUCKET.get(key);
				if (object === null)
					return new Response(null, {
						status: 404,
						headers: { "x-hobo-r2-key": keyHeader },
					});
				const body = object.body;
				if (!(body instanceof ReadableStream))
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
				return new Response(bytes, {
					status: 200,
					headers: {
						"x-hobo-r2-key": keyHeader,
						"x-hobo-r2-content-type": contentType,
						"x-hobo-r2-size": String(bytes.byteLength),
						"x-hobo-r2-digest": digest,
					},
				});
			}
			if (operation === "delete") {
				await environment.HOBO_R2_BUCKET.delete(key);
				return new Response(null, {
					status: 204,
					headers: { "x-hobo-r2-key": keyHeader },
				});
			}
			const contentType = decodeCloudflareR2ContentType(
				request.headers.get("x-hobo-r2-content-type"),
			);
			const expectedSize = size(request.headers.get("x-hobo-r2-size"));
			const digest = request.headers.get("x-hobo-r2-digest");
			if (digest === null || !validCloudflareR2Digest(digest))
				return failure("R2_OBJECT_INVALID", 400);
			const bytes = await readCloudflareR2Bytes(request.body);
			if (
				bytes.byteLength !== expectedSize ||
				(await cloudflareR2Digest(bytes)) !== digest
			)
				return failure("R2_INTEGRITY_UNVERIFIED", 422);
			const object = await environment.HOBO_R2_BUCKET.put(key, bytes, {
				httpMetadata: { contentType },
				customMetadata: { "hobo-sha256": digest },
				sha256: digest.slice(7),
			});
			if (
				object === null ||
				object.key !== key ||
				object.size !== bytes.byteLength ||
				object.httpMetadata?.contentType !== contentType ||
				object.customMetadata?.["hobo-sha256"] !== digest
			)
				return failure("R2_MUTATION_OUTCOME_UNKNOWN", 502);
			return new Response(null, {
				status: 204,
				headers: {
					"x-hobo-r2-key": keyHeader,
					"x-hobo-r2-content-type": encodeCloudflareR2ContentType(contentType),
					"x-hobo-r2-size": String(bytes.byteLength),
					"x-hobo-r2-digest": digest,
				},
			});
		} catch (error) {
			if (error instanceof CloudflareR2Error) return failure(error.code, 422);
			return failure(
				operation === "read"
					? "R2_READ_UNAVAILABLE"
					: "R2_MUTATION_OUTCOME_UNKNOWN",
				502,
			);
		}
	},
};
export default cloudflareR2Proxy;
