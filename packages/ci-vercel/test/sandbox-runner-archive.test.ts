import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	collectVerifiedRunnerArchive,
	downloadSandboxRunner,
	SANDBOX_RUNNER_URL,
} from "../src/sandbox-runner-archive.js";

describe("host-side runner download", () => {
	it("reports a failed fetch as a download failure, without its cause's text", async () => {
		await expect(
			downloadSandboxRunner(async () => {
				throw new Error("ECONNRESET secret-host.internal");
			}),
		).rejects.toThrow(new Error("runner download failed"));
	});
	it("validates a complete bounded archive before making it available", async () => {
		const content = Buffer.from("fixture-archive");
		const sha = createHash("sha256").update(content).digest("hex");
		const response = new Response(content, {
			headers: { "content-length": String(content.length) },
		});
		expect(
			await collectVerifiedRunnerArchive(
				response,
				sha,
				1024,
				AbortSignal.timeout(1000),
			),
		).toEqual(content);
		await expect(
			collectVerifiedRunnerArchive(
				new Response("tampered"),
				sha,
				1024,
				AbortSignal.timeout(1000),
			),
		).rejects.toThrow("checksum mismatch");
	});
	it("rejects both declared and streamed oversized archives", async () => {
		const sha = "0".repeat(64);
		await expect(
			collectVerifiedRunnerArchive(
				new Response("x", { headers: { "content-length": "100" } }),
				sha,
				10,
				AbortSignal.timeout(1000),
			),
		).rejects.toThrow("too large");
		await expect(
			collectVerifiedRunnerArchive(
				new Response("a".repeat(11)),
				sha,
				10,
				AbortSignal.timeout(1000),
			),
		).rejects.toThrow("too large");
	});
	it("rejects untrusted and non-HTTPS redirects before another request", async () => {
		for (const target of [
			"http://github.com/runner",
			"https://attacker.example/runner",
			"https://github.com:8443/runner",
			"https://user:pass@github.com/runner",
		]) {
			let count = 0;
			const fetcher: typeof fetch = async () => {
				count++;
				return new Response(null, {
					status: 302,
					headers: { location: target },
				});
			};
			await expect(downloadSandboxRunner(fetcher)).rejects.toThrow(
				"untrusted runner redirect",
			);
			expect(count).toBe(1);
		}
	});
	it("follows only approved release hosts and still enforces the pinned digest", async () => {
		const visited: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			visited.push(String(input));
			if (visited.length === 1)
				return new Response(null, {
					status: 302,
					headers: {
						location: "https://release-assets.githubusercontent.com/fixture",
					},
				});
			return new Response("forged");
		};
		await expect(downloadSandboxRunner(fetcher)).rejects.toThrow(
			"checksum mismatch",
		);
		expect(visited).toEqual([
			SANDBOX_RUNNER_URL,
			"https://release-assets.githubusercontent.com/fixture",
		]);
	});
	it("bounds a stalled response body", async () => {
		const body = new ReadableStream<Uint8Array>({});
		await expect(
			collectVerifiedRunnerArchive(
				new Response(body),
				"0".repeat(64),
				100,
				AbortSignal.timeout(20),
			),
		).rejects.toThrow("timed out");
	});
});
