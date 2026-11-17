import {
	CLOUDFLARE_KV_MAX_VALUE_BYTES,
	CloudflareKvError,
	decodeCloudflareKvKey,
	readCloudflareKvBytes,
} from "./cloudflare-kv-protocol.js";

/** The host Worker holds the native namespace; the application receives only a service binding. */
export interface CloudflareKvProxyEnvironment {
	readonly HOBO_KV_MODE: "read-only" | "write-only";
	readonly HOBO_KV_ALLOW: "get" | "set" | "delete" | "delete,set";
	readonly HOBO_KV_NAMESPACE: {
		get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
		put(key: string, value: ArrayBuffer): Promise<void>;
		delete(key: string): Promise<void>;
	};
}

export const cloudflareKvProxy = {
	async fetch(
		request: Request,
		environment: CloudflareKvProxyEnvironment,
	): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST" || url.origin !== "https://hobo-kv.internal")
			return new Response(null, { status: 400 });
		const operation = url.pathname;
		const mode = environment.HOBO_KV_MODE;
		const allow = environment.HOBO_KV_ALLOW;
		if (
			(mode !== "read-only" && mode !== "write-only") ||
			(mode === "read-only" && (allow !== "get" || operation !== "/get")) ||
			(mode === "write-only" &&
				(!["set", "delete", "delete,set"].includes(allow) ||
					(operation !== "/set" && operation !== "/delete") ||
					!allow.split(",").includes(operation.slice(1))))
		)
			return new Response(null, { status: 403 });
		let key: string;
		try {
			key = decodeCloudflareKvKey(request.headers.get("x-hobo-kv-key"));
		} catch {
			return new Response(null, { status: 400 });
		}
		try {
			if (operation === "/get") {
				const value = await environment.HOBO_KV_NAMESPACE.get(
					key,
					"arrayBuffer",
				);
				if (value === null) return new Response(null, { status: 404 });
				if (
					!(value instanceof ArrayBuffer) ||
					value.byteLength > CLOUDFLARE_KV_MAX_VALUE_BYTES
				)
					return new Response(null, { status: 502 });
				return new Response(value, { status: 200 });
			}
			if (operation === "/delete") {
				await environment.HOBO_KV_NAMESPACE.delete(key);
				return new Response(null, { status: 204 });
			}
			const value = await readCloudflareKvBytes(request.body);
			await environment.HOBO_KV_NAMESPACE.put(key, value);
			return new Response(null, { status: 204 });
		} catch (error) {
			if (error instanceof CloudflareKvError)
				return new Response(null, { status: 413 });
			// A failed write response can be ambiguous; the caller must not retry blindly.
			return new Response(null, { status: 502 });
		}
	},
};

export default cloudflareKvProxy;
