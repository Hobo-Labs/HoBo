import { expect, it } from "vitest";
import {
	cloudflareByobOptions,
	cloudflareHeaders,
	cloudflareR2PutOptions,
	cloudflareR2ReadResult,
	cloudflareRequestInit,
	cloudflareResponseInit,
} from "../src/cloudflare-web-options.js";

it("constructs adapter option records without inherited callback-modified fields", () => {
	const keys = [
		"status",
		"headers",
		"method",
		"signal",
		"body",
		"mode",
		"httpMetadata",
		"customMetadata",
		"contentType",
		"sha256",
		"toJSON",
	];
	const originals = keys.map((key) =>
		Object.getOwnPropertyDescriptor(Object.prototype, key),
	);
	const signal = new AbortController().signal;
	const bytes = new Uint8Array([1, 2]);
	let traps = 0;
	let snapshots: unknown[] = [];
	try {
		for (const key of keys)
			Object.defineProperty(Object.prototype, key, {
				configurable: true,
				get() {
					traps++;
					return undefined;
				},
			});
		const headers = cloudflareHeaders("x-hobo-key", "value");
		const request = cloudflareRequestInit(headers, signal, bytes);
		const response = cloudflareResponseInit(503, headers);
		const put = cloudflareR2PutOptions("text/plain", "a".repeat(64));
		const result = cloudflareR2ReadResult(
			"key",
			"text/plain",
			2,
			"digest",
			bytes,
		);
		snapshots = [
			Object.getPrototypeOf(headers),
			Object.getPrototypeOf(request),
			Object.getPrototypeOf(response),
			Object.getPrototypeOf(put),
			Object.getPrototypeOf(put.httpMetadata),
			Object.getPrototypeOf(put.customMetadata),
			Object.getPrototypeOf(result),
			Object.getPrototypeOf(cloudflareByobOptions),
			request.method,
			response.status,
			put.httpMetadata.contentType,
			put.customMetadata["hobo-sha256"],
		];
	} finally {
		for (let index = 0; index < keys.length; index++) {
			const key = keys[index];
			if (key === undefined) continue;
			const original = originals[index];
			if (original === undefined) Reflect.deleteProperty(Object.prototype, key);
			else Object.defineProperty(Object.prototype, key, original);
		}
	}
	expect(traps).toBe(0);
	expect(snapshots.slice(0, 8)).toEqual(Array(8).fill(null));
	expect(snapshots.slice(8)).toEqual([
		"POST",
		503,
		"text/plain",
		`sha256:${"a".repeat(64)}`,
	]);
});
