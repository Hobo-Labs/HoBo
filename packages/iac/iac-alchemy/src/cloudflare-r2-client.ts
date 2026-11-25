import {
	CLOUDFLARE_R2_MAX_OBJECT_BYTES,
	CloudflareR2Error,
	cloudflareR2Digest,
	decodeCloudflareR2ContentType,
	encodeCloudflareR2ContentType,
	encodeCloudflareR2Key,
	readCloudflareR2Bytes,
	validCloudflareR2Digest,
	withCloudflareR2Deadline,
} from "./cloudflare-r2-protocol.js";
import {
	cloudflareAbortSignal,
	cloudflareDiscardResponse,
	cloudflareHeaders,
	cloudflareProtectResponse,
	cloudflareR2ReadResult,
	cloudflareRequestInit,
	cloudflareResponseBody,
	cloudflareResponseHeader,
	cloudflareResponseStatus,
} from "./cloudflare-web-options.js";

const applyHostMethod = Reflect.apply;
const getHostMethod = Reflect.get;
const NativeAbortController = AbortController;
const NativeRequest = Request;
const NativeBytes = Uint8Array;
const abortController = AbortController.prototype.abort;
const byteLengthGetter = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get;

export interface CloudflareR2Object {
	readonly name: string;
	readonly contentType: string;
	readonly digest: string;
	readonly size: number;
	readonly body: Uint8Array;
}

export interface CloudflareR2Store {
	read(name: string): Promise<CloudflareR2Object | undefined>;
	write(object: CloudflareR2Object): Promise<void>;
	delete(name: string): Promise<void>;
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get, anti-slop/no-reflect-apply -- SAFETY: the Workers service binding and application object cross external runtime boundaries and are validated here. */
export function createCloudflareR2Store(
	service: unknown,
	allow: readonly string[],
): CloudflareR2Store {
	let allowRead = false;
	let allowWrite = false;
	let allowDelete = false;
	for (let index = 0; index < allow.length; index++) {
		if (allow[index] === "read") allowRead = true;
		if (allow[index] === "write") allowWrite = true;
		if (allow[index] === "delete") allowDelete = true;
	}
	function discard(response: unknown): void {
		cloudflareDiscardResponse(response);
	}
	function authorize(operation: string): void {
		if (
			!(operation === "read" && allowRead) &&
			!(operation === "write" && allowWrite) &&
			!(operation === "delete" && allowDelete)
		)
			throw new CloudflareR2Error(
				"R2_OPERATION_DENIED",
				"operation is not granted",
			);
	}
	async function perform(
		operation: "read" | "write" | "delete",
		headers: Record<string, string>,
		body?: ArrayBuffer,
	): Promise<Response> {
		try {
			const controller = new NativeAbortController();
			const init = cloudflareRequestInit(
				headers,
				cloudflareAbortSignal(controller),
				body,
			);
			const request = new NativeRequest(
				`https://hobo-r2.internal/${operation}`,
				init,
			);
			if (typeof service !== "object" || service === null)
				throw new Error("service unavailable");
			const fetch = getHostMethod(service, "fetch");
			if (typeof fetch !== "function") throw new Error("service unavailable");
			const result = await withCloudflareR2Deadline<unknown>(
				() => applyHostMethod(fetch, service, [request]),
				() => applyHostMethod(abortController, controller, []),
				cloudflareDiscardResponse,
			);
			const response = result.value;
			if (!cloudflareProtectResponse(response))
				throw new Error("invalid service response");
			return response;
		} catch {
			throw new CloudflareR2Error(
				operation === "read"
					? "R2_READ_UNAVAILABLE"
					: "R2_MUTATION_OUTCOME_UNKNOWN",
				operation === "read"
					? "object read failed"
					: "mutation may have taken effect; reconcile before retry",
			);
		}
	}
	return Object.freeze({
		async read(
			name: string,
			...options: never[]
		): Promise<CloudflareR2Object | undefined> {
			if (options.length !== 0)
				throw new CloudflareR2Error(
					"R2_REQUEST_INVALID",
					"read options are unsupported",
				);
			authorize("read");
			const key = encodeCloudflareR2Key(name);
			const response = await perform(
				"read",
				cloudflareHeaders("x-hobo-r2-key", key),
			);
			const status = cloudflareResponseStatus(response);
			if (
				cloudflareResponseHeader(response, "x-hobo-r2-key") !== key &&
				(status === 200 || status === 404)
			) {
				discard(response);
				throw new CloudflareR2Error(
					"R2_READ_UNAVAILABLE",
					"object receipt does not match the request",
				);
			}
			if (status === 404) {
				discard(response);
				return undefined;
			}
			if (status !== 200) {
				const reason = cloudflareResponseHeader(response, "x-hobo-r2-error");
				discard(response);
				if (
					reason === "R2_METADATA_UNSUPPORTED" ||
					reason === "R2_INTEGRITY_UNVERIFIED" ||
					reason === "R2_OBJECT_TOO_LARGE"
				)
					throw new CloudflareR2Error(
						reason,
						"object cannot be represented by this subset",
					);
				throw new CloudflareR2Error(
					"R2_READ_UNAVAILABLE",
					"object read failed",
				);
			}
			try {
				const contentType = decodeCloudflareR2ContentType(
					cloudflareResponseHeader(response, "x-hobo-r2-content-type"),
				);
				const size = cloudflareResponseHeader(response, "x-hobo-r2-size");
				const digest = cloudflareResponseHeader(response, "x-hobo-r2-digest");
				if (
					size === null ||
					!/^(0|[1-9][0-9]{0,6})$/u.test(size) ||
					Number(size) > CLOUDFLARE_R2_MAX_OBJECT_BYTES ||
					digest === null ||
					!validCloudflareR2Digest(digest)
				)
					throw new Error("invalid metadata");
				const body = await readCloudflareR2Bytes(
					cloudflareResponseBody(response),
				);
				if (
					body.byteLength !== Number(size) ||
					(await cloudflareR2Digest(body)) !== digest
				)
					throw new Error("object mismatch");
				return cloudflareR2ReadResult(
					name,
					contentType,
					body.byteLength,
					digest,
					new NativeBytes(body),
				);
			} catch {
				discard(response);
				throw new CloudflareR2Error(
					"R2_READ_UNAVAILABLE",
					"object response was incomplete or invalid",
				);
			}
		},
		async write(
			object: CloudflareR2Object,
			...options: never[]
		): Promise<void> {
			if (options.length !== 0)
				throw new CloudflareR2Error(
					"R2_REQUEST_INVALID",
					"write options are unsupported",
				);
			authorize("write");
			if (
				typeof object !== "object" ||
				object === null ||
				Array.isArray(object) ||
				Object.getOwnPropertySymbols(object).length !== 0
			) {
				throw new CloudflareR2Error(
					"R2_OBJECT_INVALID",
					"an object with exact data properties is required",
				);
			}
			const properties = Object.getOwnPropertyDescriptors(object);
			if (
				Object.keys(properties).length !== 5 ||
				["name", "contentType", "digest", "size", "body"].some(
					(key) =>
						properties[key] === undefined ||
						!("value" in properties[key]) ||
						!properties[key].enumerable,
				)
			) {
				throw new CloudflareR2Error(
					"R2_OBJECT_INVALID",
					"an object with exact data properties is required",
				);
			}
			const { name, contentType, digest, size, body } = Object.fromEntries(
				Object.entries(properties).map(([key, value]) => [key, value.value]),
			);
			const key = encodeCloudflareR2Key(name);
			const content = encodeCloudflareR2ContentType(contentType);
			if (
				!validCloudflareR2Digest(digest) ||
				!Number.isSafeInteger(size) ||
				size < 0 ||
				!(body instanceof Uint8Array) ||
				!ArrayBuffer.isView(body) ||
				size > CLOUDFLARE_R2_MAX_OBJECT_BYTES
			)
				throw new CloudflareR2Error(
					"R2_OBJECT_INVALID",
					"object size, digest or bytes are invalid",
				);
			let actualLength: number | undefined;
			try {
				actualLength =
					byteLengthGetter === undefined
						? undefined
						: applyHostMethod(byteLengthGetter, body, []);
			} catch {
				throw new CloudflareR2Error(
					"R2_OBJECT_INVALID",
					"object bytes cannot be inspected",
				);
			}
			if (
				actualLength === undefined ||
				actualLength !== size ||
				actualLength > CLOUDFLARE_R2_MAX_OBJECT_BYTES
			)
				throw new CloudflareR2Error(
					"R2_OBJECT_INVALID",
					"object size does not match bytes",
				);
			const bytes = new NativeBytes(body).buffer;
			if ((await cloudflareR2Digest(bytes)) !== digest)
				throw new CloudflareR2Error(
					"R2_INTEGRITY_UNVERIFIED",
					"object digest does not match bytes",
				);
			const headers = cloudflareHeaders("x-hobo-r2-key", key);
			headers["x-hobo-r2-content-type"] = content;
			headers["x-hobo-r2-size"] = String(size);
			headers["x-hobo-r2-digest"] = digest;
			const response = await perform("write", headers, bytes);
			if (
				cloudflareResponseStatus(response) !== 204 ||
				cloudflareResponseHeader(response, "x-hobo-r2-key") !== key ||
				cloudflareResponseHeader(response, "x-hobo-r2-content-type") !==
					content ||
				cloudflareResponseHeader(response, "x-hobo-r2-size") !== String(size) ||
				cloudflareResponseHeader(response, "x-hobo-r2-digest") !== digest
			) {
				discard(response);
				throw new CloudflareR2Error(
					"R2_MUTATION_OUTCOME_UNKNOWN",
					"write receipt does not match; reconcile before retry",
				);
			}
		},
		async delete(name: string, ...options: never[]): Promise<void> {
			if (options.length !== 0)
				throw new CloudflareR2Error(
					"R2_REQUEST_INVALID",
					"delete options are unsupported",
				);
			authorize("delete");
			const key = encodeCloudflareR2Key(name);
			const response = await perform(
				"delete",
				cloudflareHeaders("x-hobo-r2-key", key),
			);
			if (
				cloudflareResponseStatus(response) !== 204 ||
				cloudflareResponseHeader(response, "x-hobo-r2-key") !== key
			) {
				discard(response);
				throw new CloudflareR2Error(
					"R2_MUTATION_OUTCOME_UNKNOWN",
					"delete receipt does not match; reconcile before retry",
				);
			}
		},
	});
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get, anti-slop/no-reflect-apply */
