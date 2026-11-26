import { describe, expect, it, vi } from "vitest";
import {
	downloadSandboxIcu,
	SANDBOX_ICU_BYTES,
	SANDBOX_ICU_URL,
} from "../src/sandbox-runner-icu.js";

describe("isolated runner ICU package", () => {
	it("pins the Ubuntu URL and rejects bytes without the expected digest", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => new Response("forged"));
		await expect(downloadSandboxIcu(fetcher)).rejects.toThrow(
			"checksum mismatch",
		);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher.mock.calls[0]?.[0]).toBe(SANDBOX_ICU_URL);
		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
	});
	it("rejects oversized packages before reading their body", async () => {
		const fetcher: typeof fetch = async () =>
			new Response("x", {
				headers: { "content-length": String(SANDBOX_ICU_BYTES + 1) },
			});
		await expect(downloadSandboxIcu(fetcher)).rejects.toThrow("too large");
	});
	it("rejects redirects even if a fetch implementation followed one", async () => {
		const response = new Response("x");
		Object.defineProperty(response, "redirected", { value: true });
		await expect(downloadSandboxIcu(async () => response)).rejects.toThrow(
			"unexpected ICU redirect",
		);
	});
	it("bounds a fetcher that does not itself honor abort signals", async () => {
		const controller = new AbortController();
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(controller.signal);
		try {
			const stalled: typeof fetch = () => new Promise(() => {});
			const result = downloadSandboxIcu(stalled);
			controller.abort();
			await expect(result).rejects.toThrow("timed out");
		} finally {
			timeout.mockRestore();
		}
	});
});
