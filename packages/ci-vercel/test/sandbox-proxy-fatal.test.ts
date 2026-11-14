/**
 * A proxy listener error is fatal even after the proxy began serving: the
 * fixed failure stage is reported, then the process exits.
 */
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installProxyFatalErrorHandler } from "../src/sandbox-proxy-vm.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the proxy's fatal error handler", () => {
	it("reports once and exits", async () => {
		// SAFETY: process.exit never returns; the stand-in only records the call.
		const exit = vi
			.spyOn(process, "exit")
			.mockImplementation(() => undefined as never);
		const server = createServer();
		const report = vi.fn(async () => undefined);
		installProxyFatalErrorHandler(server, report);
		server.emit("error", new Error("EADDRINUSE"));
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
		expect(report).toHaveBeenCalledOnce();
		// Only the first error is handled.
		expect(server.listenerCount("error")).toBe(0);
	});
});
