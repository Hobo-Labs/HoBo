import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import { applyEgressToProcess } from "../../src/index.js";
import { startForwardProxy } from "../support/remote-owner.js";

// SPEC: egress is applied once, to the whole process, before anything
// connects. Derived from the real-binary smoke: the CD journal's Neon
// provisioner used Node's global fetch, which ignores HTTPS_PROXY, so it went
// around the box's proxy (on an enterprise network it would simply fail).
// Fixing each call site is whack-a-mole; the process's global dispatcher is
// the one place every fetch goes through.

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
		applyEgressToProcess({ HTTPS_PROXY: proxy.url(), NO_PROXY: "" });
		await fetch("https://neon.new/api/v1/database", { method: "POST" }).catch(
			() => undefined,
		);
		expect(proxy.seen).toContain("CONNECT neon.new:443");
	});

	it("leaves the process alone when no proxy and no CA are configured", () => {
		const before = getGlobalDispatcher();
		applyEgressToProcess({});
		expect(getGlobalDispatcher()).toBe(before);
	});

	it("opens the CA bundle only when a request needs it: a bad path fails that request, not the process", async () => {
		// Derived from the OpenSesame bin test: a run configured with a CA it
		// never uses must still start.
		expect(() =>
			applyEgressToProcess({ NODE_EXTRA_CA_CERTS: "/nonexistent/run-ca.pem" }),
		).not.toThrow();
		await expect(fetch("https://example.invalid/")).rejects.toThrow();
	});
});

