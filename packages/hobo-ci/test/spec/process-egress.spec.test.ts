import { mkdtempSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

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
		// A local endpoint can close the tunnel as soon as it is reached. This
		// checks proxy routing without waiting on an external host or its DNS.
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
		// Derived from the OpenSesame bin test: a run configured with a CA it
		// never uses must still start.
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
