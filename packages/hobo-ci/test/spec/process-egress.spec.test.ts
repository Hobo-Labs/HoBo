import { mkdtempSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { applyEgressToProcess } from "../../src/index.js";
import { startForwardProxy } from "../support/remote-owner.js";

const previous = getGlobalDispatcher();
const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
	setGlobalDispatcher(previous);
	await Promise.all(open.splice(0).map((server) => server.close()));
});

describe("SPEC process egress: every fetch in the process honours the proxy", () => {
	it("a plain global fetch goes through the proxy the environment requires", async () => {
		const proxy = await startForwardProxy({});
		open.push(proxy);
		const target = createServer((socket) => socket.destroy());
		await new Promise<void>((resolve) =>
			target.listen(0, "127.0.0.1", resolve),
		);
		open.push({
			close: () =>
				new Promise<void>((resolve) => target.close(() => resolve())),
		});
		// SAFETY: target has just started listening on an IPv4 TCP socket.
		const { port } = target.address() as AddressInfo;
		applyEgressToProcess({ HTTPS_PROXY: proxy.url(), NO_PROXY: "" });
		await fetch(`https://127.0.0.1:${port}/api/v1/database`, {
			method: "POST",
		}).catch(() => undefined);
		expect(proxy.seen).toContain(`CONNECT 127.0.0.1:${port}`);
	});

	it("leaves the process alone when no proxy and no CA are configured", () => {
		const before = getGlobalDispatcher();
		applyEgressToProcess({});
		expect(getGlobalDispatcher()).toBe(before);
	});

	it("opens the CA bundle only when a request needs it: a bad path fails that request, not the process", async () => {
		const absent = path.join(
			mkdtempSync(path.join(tmpdir(), "hobo-egress-")),
			"absent-ca.pem",
		);
		expect(() =>
			applyEgressToProcess({ NODE_EXTRA_CA_CERTS: absent }),
		).not.toThrow();
		await expect(fetch("https://example.invalid/")).rejects.toThrow();
	});
});
