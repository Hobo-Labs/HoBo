import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installProxyFatalErrorHandler } from "../src/sandbox-proxy-vm.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("the proxy's fatal error handler", () => {
	it("reports once and exits", async () => {
		const exit = vi
			.spyOn(process, "exit")
			.mockImplementation(vi.fn<typeof process.exit>());
		const server = createServer();
		const report = vi.fn(async () => undefined);
		installProxyFatalErrorHandler(server, report);
		server.emit("error", new Error("EADDRINUSE"));
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
		expect(report).toHaveBeenCalledOnce();
		expect(server.listenerCount("error")).toBe(0);
	});
});
