import { cancelCloudflareByteStream } from "./cloudflare-byte-stream.js";
import {
	CloudflareKvError,
	decodeCloudflareKvKey,
	readCloudflareKvBytes,
} from "./cloudflare-kv-protocol.js";
import { awaitCloudflareNative } from "./cloudflare-native-await.js";
import {
	cloudflareRequestBody,
	cloudflareRequestHeader,
	cloudflareRequestMethod,
	cloudflareRequestUrl,
	cloudflareResponse,
} from "./cloudflare-web-options.js";

const NativeURL = URL;

export interface CloudflareKvProxyEnvironment {
	readonly HOBO_KV_MODE: "read-only" | "write-only";
	readonly HOBO_KV_ALLOW: "get" | "set" | "delete" | "delete,set";
	readonly HOBO_KV_NAMESPACE: {
		get(
			key: string,
			type: "stream",
		): Promise<ReadableStream<Uint8Array> | null>;
		put(key: string, value: ArrayBuffer): Promise<void>;
		delete(key: string): Promise<void>;
	};
}

export const cloudflareKvProxy = {
	async fetch(
		request: Request,
		environment: CloudflareKvProxyEnvironment,
	): Promise<Response> {
		const url = new NativeURL(cloudflareRequestUrl(request));
		if (
			cloudflareRequestMethod(request) !== "POST" ||
			url.origin !== "https://hobo-kv.internal"
		)
			return cloudflareResponse(null, 400);
		const operation = url.pathname;
		const mode = environment.HOBO_KV_MODE;
		const allow = environment.HOBO_KV_ALLOW;
		if (
			(mode !== "read-only" && mode !== "write-only") ||
			(mode === "read-only" && (allow !== "get" || operation !== "/get")) ||
			(mode === "write-only" &&
				((operation !== "/set" && operation !== "/delete") ||
					(operation === "/set" && allow !== "set" && allow !== "delete,set") ||
					(operation === "/delete" &&
						allow !== "delete" &&
						allow !== "delete,set")))
		)
			return cloudflareResponse(null, 403);
		let key: string;
		try {
			key = decodeCloudflareKvKey(
				cloudflareRequestHeader(request, "x-hobo-kv-key"),
			);
		} catch {
			return cloudflareResponse(null, 400);
		}
		try {
			if (operation === "/get") {
				const result = await awaitCloudflareNative(
					() => environment.HOBO_KV_NAMESPACE.get(key, "stream"),
					undefined,
					(stream, lease) =>
						stream === null
							? "none"
							: cancelCloudflareByteStream(stream, lease),
				);
				const value = result.value;
				if (value === null) return cloudflareResponse(null, 404);
				return cloudflareResponse(await readCloudflareKvBytes(value), 200);
			}
			if (operation === "/delete") {
				await awaitCloudflareNative(() =>
					environment.HOBO_KV_NAMESPACE.delete(key),
				);
				return cloudflareResponse(null, 204);
			}
			const value = await readCloudflareKvBytes(cloudflareRequestBody(request));
			await awaitCloudflareNative(() =>
				environment.HOBO_KV_NAMESPACE.put(key, value),
			);
			return cloudflareResponse(null, 204);
		} catch (error) {
			if (error instanceof CloudflareKvError)
				return cloudflareResponse(null, 413);

			return cloudflareResponse(null, 502);
		}
	},
};

export default cloudflareKvProxy;
