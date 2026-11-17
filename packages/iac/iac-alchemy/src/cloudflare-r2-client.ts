import {
	CLOUDFLARE_R2_MAX_OBJECT_BYTES,
	CloudflareR2Error,
	cloudflareR2Digest,
	decodeCloudflareR2ContentType,
	encodeCloudflareR2ContentType,
	encodeCloudflareR2Key,
	readCloudflareR2Bytes,
	validCloudflareR2Digest,
} from "./cloudflare-r2-protocol.js";

export interface CloudflareR2Object {
	readonly name: string;
	readonly contentType: string;
	readonly digest: string;
	readonly size: number;
	readonly body: Uint8Array;
}

/** Provider-specific JavaScript subset; no events, presigning, streaming or WASI guest binding. */
export interface CloudflareR2Store {
	read(name: string): Promise<CloudflareR2Object | undefined>;
	write(object: CloudflareR2Object): Promise<void>;
	delete(name: string): Promise<void>;
}

/** This client receives only the private service binding, never native R2 access. */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get, anti-slop/no-reflect-apply -- SAFETY: the Workers service binding and application object cross external runtime boundaries and are validated here. */
export function createCloudflareR2Store(
	service: unknown,
	allow: readonly string[],
): CloudflareR2Store {
	const granted = new Set(allow);
	function discard(response: Response): void {
		if (response.body !== null) void response.body.cancel().catch(() => {});
	}
	function authorize(operation: string): void {
		if (!granted.has(operation))
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
		const controller = new AbortController();
		const init: RequestInit = {
			method: "POST",
			headers,
			signal: controller.signal,
		};
		if (body !== undefined) init.body = body;
		const request = new Request(`https://hobo-r2.internal/${operation}`, init);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			if (typeof service !== "object" || service === null)
				throw new Error("service unavailable");
			const fetch = Reflect.get(service, "fetch");
			if (typeof fetch !== "function") throw new Error("service unavailable");
			const pending = Promise.resolve(
				Reflect.apply(fetch, service, [request]),
			).then((result) => {
				if (controller.signal.aborted && result instanceof Response)
					discard(result);
				return result;
			});
			const response = await Promise.race([
				pending,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(new Error("service timed out"));
					}, 10_000);
				}),
			]);
			if (!(response instanceof Response))
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
		} finally {
			if (timer !== undefined) clearTimeout(timer);
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
			const response = await perform("read", { "x-hobo-r2-key": key });
			if (
				response.headers.get("x-hobo-r2-key") !== key &&
				[200, 404].includes(response.status)
			) {
				discard(response);
				throw new CloudflareR2Error(
					"R2_READ_UNAVAILABLE",
					"object receipt does not match the request",
				);
			}
			if (response.status === 404) {
				discard(response);
				return undefined;
			}
			if (response.status !== 200) {
				const reason = response.headers.get("x-hobo-r2-error");
				discard(response);
				if (
					[
						"R2_METADATA_UNSUPPORTED",
						"R2_INTEGRITY_UNVERIFIED",
						"R2_OBJECT_TOO_LARGE",
					].includes(reason ?? "")
				)
					throw new CloudflareR2Error(
						reason ?? "R2_READ_UNAVAILABLE",
						"object cannot be represented by this subset",
					);
				throw new CloudflareR2Error(
					"R2_READ_UNAVAILABLE",
					"object read failed",
				);
			}
			try {
				const contentType = decodeCloudflareR2ContentType(
					response.headers.get("x-hobo-r2-content-type"),
				);
				const size = response.headers.get("x-hobo-r2-size");
				const digest = response.headers.get("x-hobo-r2-digest");
				if (
					size === null ||
					!/^(0|[1-9][0-9]{0,6})$/u.test(size) ||
					Number(size) > CLOUDFLARE_R2_MAX_OBJECT_BYTES ||
					digest === null ||
					!validCloudflareR2Digest(digest)
				)
					throw new Error("invalid metadata");
				const body = await readCloudflareR2Bytes(response.body);
				if (
					body.byteLength !== Number(size) ||
					(await cloudflareR2Digest(body)) !== digest
				)
					throw new Error("object mismatch");
				return Object.freeze({
					name,
					contentType,
					size: body.byteLength,
					digest,
					body: new Uint8Array(body),
				});
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
				body.byteLength !== size ||
				size > CLOUDFLARE_R2_MAX_OBJECT_BYTES
			)
				throw new CloudflareR2Error(
					"R2_OBJECT_INVALID",
					"object size, digest or bytes are invalid",
				);
			const bytes = new Uint8Array(body).buffer;
			if ((await cloudflareR2Digest(bytes)) !== digest)
				throw new CloudflareR2Error(
					"R2_INTEGRITY_UNVERIFIED",
					"object digest does not match bytes",
				);
			const response = await perform(
				"write",
				{
					"x-hobo-r2-key": key,
					"x-hobo-r2-content-type": content,
					"x-hobo-r2-size": String(size),
					"x-hobo-r2-digest": digest,
				},
				bytes,
			);
			if (
				response.status !== 204 ||
				response.headers.get("x-hobo-r2-key") !== key ||
				response.headers.get("x-hobo-r2-content-type") !== content ||
				response.headers.get("x-hobo-r2-size") !== String(size) ||
				response.headers.get("x-hobo-r2-digest") !== digest
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
			const response = await perform("delete", { "x-hobo-r2-key": key });
			if (
				response.status !== 204 ||
				response.headers.get("x-hobo-r2-key") !== key
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
