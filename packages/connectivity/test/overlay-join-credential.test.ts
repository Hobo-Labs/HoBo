/**
 * The overlay join credential (L14, ADR-0182): it is only ever the
 * `OverlayJoin.credential` the fleet authority minted at enrollment, handed
 * to `join` by the host. No adapter reads one from the environment or holds
 * a static one, and none passes it on a command line.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { type OverlayJoinOptions, parseTenantId } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { createNetbirdOverlay } from "../src/overlay/netbird.js";
import {
	createTailscaleOverlay,
	type TailscaleRunner,
} from "../src/overlay/tailscale.js";

const STATUS_JSON = JSON.stringify({
	Self: {
		ID: "node-abc",
		DNSName: "laptop.tailnet.ts.net.",
		TailscaleIPs: ["100.64.0.1"],
	},
});
const KEY_FLAG = "--auth-key=file:";

function join(authKey?: string): OverlayJoinOptions {
	const base = {
		tenantId: parseTenantId("acme"),
		hostname: "laptop-1",
		tags: ["tag:hobo-fleet"],
	};
	return authKey === undefined ? base : { ...base, authKey };
}

type Seen = { args: string[]; mode?: number; content?: string };

function recordingRunner(seen: Seen[]): TailscaleRunner {
	return (args) => {
		const entry: Seen = { args: [...args] };
		const keyArg = args.find((arg) => arg.startsWith(KEY_FLAG));
		if (keyArg !== undefined) {
			const path = keyArg.slice(KEY_FLAG.length);
			entry.mode = statSync(path).mode & 0o777;
			entry.content = readFileSync(path, "utf8");
		}
		seen.push(entry);
		return {
			ok: true,
			stdout: args[0] === "status" ? STATUS_JSON : "",
			stderr: "",
		};
	};
}

describe("tailscale join credential", () => {
	it("is read by tailscale from a private file, never from argv, and the file is gone afterwards", async () => {
		const seen: Seen[] = [];
		const net = createTailscaleOverlay({ run: recordingRunner(seen) });
		await net.join(join("tskey-auth-secret-value"));

		const up = seen.find((entry) => entry.args[0] === "up");
		expect(up).toBeDefined();
		expect(seen.flatMap((entry) => entry.args).join(" ")).not.toContain(
			"tskey-auth-secret-value",
		);
		expect(up?.mode).toBe(0o600);
		expect(up?.content).toBe("tskey-auth-secret-value");
		const path =
			up?.args
				.find((arg) => arg.startsWith(KEY_FLAG))
				?.slice(KEY_FLAG.length) ?? "";
		expect(existsSync(path)).toBe(false);
	});

	it("removes the file even when tailscale fails", async () => {
		const paths: string[] = [];
		const net = createTailscaleOverlay({
			run: (args) => {
				const keyArg = args.find((arg) => arg.startsWith(KEY_FLAG));
				if (keyArg !== undefined) paths.push(keyArg.slice(KEY_FLAG.length));
				return {
					ok: args[0] === "status",
					stdout: args[0] === "status" ? STATUS_JSON : "",
					stderr: "authkey expired",
				};
			},
		});
		const result = await net.join(join("tskey-auth-secret-value"));
		expect(result.notes.join(" ")).toContain("authkey expired");
		expect(paths).toHaveLength(1);
		expect(existsSync(paths[0] ?? "")).toBe(false);
	});

	it("names the enrollment OverlayJoin, not an environment variable, when none is given", async () => {
		const net = createTailscaleOverlay({ run: recordingRunner([]) });
		const result = await net.join(join());
		const notes = result.notes.join(" ");
		expect(notes).toMatch(/existing tailscale session/u);
		expect(notes).toMatch(/OverlayJoin/u);
		expect(notes).not.toMatch(/AUTHKEY|env/u);
	});
});

describe("netbird join credential", () => {
	/** A management API that records every request body and authorization header. */
	function recordingFetch(seen: string[]): typeof fetch {
		return async (input, init) => {
			seen.push(
				`${String(input)} ${String(init?.body ?? "")} ${new Headers(init?.headers).get("authorization") ?? ""}`,
			);
			return new Response(JSON.stringify({ id: "peer-1", ip: "100.80.0.2" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};
	}

	it("enrolls only with the credential given to join", async () => {
		const seen: string[] = [];
		const net = createNetbirdOverlay({
			managementUrl: "https://netbird.test",
			fetchImpl: recordingFetch(seen),
		});
		await net.join(join("nb-setup-one-off"));
		expect(seen.join(" ")).toContain("nb-setup-one-off");
	});

	it("has no static setup key and reads none from the environment", async () => {
		const previous = process.env.NETBIRD_SETUP_KEY;
		process.env.NETBIRD_SETUP_KEY = "static-from-env";
		try {
			const seen: string[] = [];
			const net = createNetbirdOverlay({
				managementUrl: "https://netbird.test",
				fetchImpl: recordingFetch(seen),
			});
			const result = await net.join(join());
			expect(seen.join(" ")).not.toContain("static-from-env");
			expect(result.ready).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.NETBIRD_SETUP_KEY;
			else process.env.NETBIRD_SETUP_KEY = previous;
		}
	});
});
