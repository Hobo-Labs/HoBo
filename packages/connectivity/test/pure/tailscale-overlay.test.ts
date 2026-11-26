/**
 * The Tailscale overlay adapter, driven through an injected CLI runner.
 *
 * This adapter's defining property is that **it degrades rather than fails**.
 * A developer without `tailscale` installed, or not logged in, still gets a
 * working local environment — the join reports `ready: false` with a note
 * saying what to install, instead of throwing. That is the difference between
 * "HoBo needs a mesh VPN to run" and "HoBo uses one when you have one", so the
 * degraded paths are tested as carefully as the happy ones.
 *
 * Three refusals are worth stating, because each guards something a wrong
 * answer would expose publicly:
 *
 * **A Funnel target must be a local HTTP(S) endpoint.** Funnel publishes to the
 * public internet. Pointing it at an arbitrary host would proxy something the
 * operator did not intend to expose, so anything that is not loopback on the
 * expected port is refused before the CLI is invoked at all.
 *
 * **A `hostnameHint` must end in `.ts.net`.** The hint exists for when the CLI
 * cannot report the gateway, but accepting a raw IP or an arbitrary domain
 * would have HoBo announce a public URL it does not control and cannot serve.
 *
 * **`enabled` and `confirmed` come from the CLI, never from the hint.** A
 * gateway hostname derived from a hint is a *guess* at the address; it is not
 * evidence that Funnel is running. Reporting `enabled: true` on a hint alone
 * would tell an operator their endpoint is public when nothing is listening.
 */
import { describe, expect, it } from "vitest";

import {
	createTailscaleOverlay,
	parseTenantTag,
} from "../../src/overlay/tailscale.js";

type RunResult = { ok: boolean; stdout: string; stderr: string };

const ok = (stdout = "", stderr = ""): RunResult => ({
	ok: true,
	stdout,
	stderr,
});
const fail = (stderr = "error"): RunResult => ({
	ok: false,
	stdout: "",
	stderr,
});

const STATUS_JSON = JSON.stringify({
	Self: {
		ID: "node-abc",
		DNSName: "laptop.tailnet.ts.net.",
		TailscaleIPs: ["100.64.0.1"],
	},
});

/** A runner answering from a table keyed by the first argument. */
function runner(table: Record<string, RunResult | undefined> = {}) {
	const calls: string[][] = [];
	const run = (args: readonly string[]): RunResult => {
		calls.push([...args]);
		const key = args.join(" ");
		for (const [pattern, result] of Object.entries(table)) {
			if (key.startsWith(pattern) && result) return result;
		}
		return ok();
	};
	return {
		run,
		calls,
		ran: (needle: string) =>
			calls.some((call) => call.join(" ").includes(needle)),
	};
}

const overlay = (
	table: Record<string, RunResult | undefined> = {},
	options: Record<string, unknown> = {},
) => {
	const r = runner({ "status --json": ok(STATUS_JSON), ...table });
	return {
		...r,
		net: createTailscaleOverlay({ run: r.run, ...options } as never),
	};
};

const join = (overrides: Record<string, unknown> = {}) =>
	({
		tenantId: "t1",
		hostname: "laptop-1",
		tags: [],
		...overrides,
	}) as never;

describe("tenant tags", () => {
	it("tags a node with its tenant and role", () => {
		const tags = overlay().net.tenantTags({
			tenantId: "t1" as never,
			role: "server",
		} as never);
		expect(tags).toContain("tenant:t1");
		expect(tags).toContain("role:server");
	});

	it("maps the laptop role to Tailscale's dev-laptop ACL tag", () => {
		// The ACL is written against `tag:dev-laptop`; emitting `tag:laptop`
		// would silently match no policy at all.
		const tags = overlay().net.tenantTags({
			tenantId: "t1" as never,
			role: "laptop",
		} as never);
		expect(tags).toContain("tag:dev-laptop");
	});

	it("passes other roles through as their own tag", () => {
		expect(
			overlay().net.tenantTags({
				tenantId: "t1" as never,
				role: "server",
			} as never),
		).toContain("tag:server");
	});

	it("adds the optional dimensions only when given", () => {
		// An empty `env:` tag would match an ACL rule for the empty environment.
		const bare = overlay().net.tenantTags({
			tenantId: "t1" as never,
			role: "server",
		} as never);
		expect(bare.some((t) => t.startsWith("env:"))).toBe(false);
		const full = overlay().net.tenantTags({
			tenantId: "t1" as never,
			role: "server",
			env: "prod",
			cloud: "aws",
			overlayNetworkId: "net-1",
		} as never);
		expect(full).toEqual(
			expect.arrayContaining(["env:prod", "cloud:aws", "overlay:net-1"]),
		);
	});

	it("reads the tenant back out of a tag list", () => {
		expect(parseTenantTag(["role:server", "tenant:acme"])).toBe("acme");
	});

	it("reports no tenant when none is tagged", () => {
		expect(parseTenantTag(["role:server"])).toBeNull();
	});
});

describe("joining", () => {
	it("reports ready when the CLI answers", async () => {
		const result = await overlay().net.join(join());
		expect(result.ready).toBe(true);
		expect(result.provider).toBe("tailscale");
	});

	it("takes the node id and addresses from tailscale status", async () => {
		const result = await overlay().net.join(join());
		expect(result.identity.nodeId).toBe("node-abc");
		expect(result.identity.overlayIps).toEqual(["100.64.0.1"]);
	});

	it("tags the node with its tenant even when the caller forgot", async () => {
		// Every ACL rule is tenant-scoped; an untagged node matches none of them.
		const result = await overlay().net.join(join());
		expect(result.identity.tags).toContain("tenant:t1");
	});

	it("does not add a second tenant tag when one is present", async () => {
		const result = await overlay().net.join(join({ tags: ["tenant:other"] }));
		expect(result.identity.tags.filter((t) => t.startsWith("tenant:"))).toEqual(
			["tenant:other"],
		);
	});

	it("degrades rather than throwing when the CLI is absent", async () => {
		// The difference between "HoBo needs a mesh VPN" and "HoBo uses one when
		// you have one".
		const result = await overlay({ "status --json": fail() }).net.join(join());
		expect(result.ready).toBe(false);
		expect(result.identity.nodeId).toMatch(/^stub:/u);
	});

	it("says what to install when it degrades", async () => {
		// A degraded mode nobody can escape is just a broken mode.
		const result = await overlay({ "status --json": fail() }).net.join(join());
		expect(result.notes.join(" ")).toMatch(/install tailscale/u);
	});

	it("does not try to bring the link up when the CLI is unavailable", async () => {
		const o = overlay({ "status --json": fail() });
		await o.net.join(join({ authKey: "tskey-x" }));
		expect(o.ran("up --authkey")).toBe(false);
	});

	it("enrolls with an auth key when one is given", async () => {
		const o = overlay();
		await o.net.join(join({ authKey: "tskey-x" }));
		expect(o.ran("up")).toBe(true);
	});

	it("advertises the node's tags on enrolment", async () => {
		// Tags applied after the fact require a re-auth; passing them at `up` is
		// what makes the ACL apply from the first packet.
		const o = overlay();
		await o.net.join(join({ authKey: "tskey-x" }));
		const up = o.calls.find((c) => c[0] === "up");
		expect(up).toContain("--advertise-tags");
	});

	it("assumes an existing session when no auth key is given", async () => {
		// Re-running `up` without a key would prompt interactively and hang a
		// non-interactive deploy.
		const o = overlay();
		const result = await o.net.join(join());
		expect(o.ran("up")).toBe(false);
		expect(result.notes.join(" ")).toMatch(/existing tailscale session/u);
	});

	it("still reports ready when enrolment fails", async () => {
		// The node may already be up; the note carries the failure rather than
		// the whole join collapsing on it.
		const o = overlay({ up: fail("authkey expired") });
		const result = await o.net.join(join({ authKey: "tskey-x" }));
		expect(result.ready).toBe(true);
		expect(result.notes.join(" ")).toContain("authkey expired");
	});

	it("accepts MagicDNS so hierarchical names resolve", async () => {
		const o = overlay();
		await o.net.join(join());
		expect(o.ran("set --accept-dns=true")).toBe(true);
	});

	it("notes a failure to accept MagicDNS rather than hiding it", async () => {
		// Without it, every `*.hobo.internal` lookup silently misses.
		const result = await overlay({ set: fail() }).net.join(join());
		expect(result.notes.join(" ")).toMatch(/accept-dns failed/u);
	});

	it("survives unparseable status output", async () => {
		const result = await overlay({
			"status --json": ok("not json"),
		}).net.join(join());
		expect(result.ready).toBe(true);
		expect(result.notes.join(" ")).toMatch(/could not parse/u);
	});

	it("falls back to the hostname when status names no node", async () => {
		const result = await overlay({
			"status --json": ok(JSON.stringify({})),
		}).net.join(join());
		expect(result.identity.nodeId).toBe("laptop-1");
	});

	it("reports progress to the caller", async () => {
		const lines: string[] = [];
		await overlay().net.join(
			join({ emitProgress: (line: string) => lines.push(line) }),
		);
		expect(lines.join(" ")).toContain("joined tailscale");
	});

	it("reports progress when it degrades too", async () => {
		const lines: string[] = [];
		await overlay({ "status --json": fail() }).net.join(
			join({ emitProgress: (line: string) => lines.push(line) }),
		);
		expect(lines.join(" ")).toContain("degraded");
	});

	it("meters the join", async () => {
		const events: unknown[] = [];
		await overlay(
			{},
			{ metering: { emit: async (e: unknown) => events.push(e) } },
		).net.join(join());
		expect(events).toHaveLength(1);
	});

	it("meters a degraded join as not ready", async () => {
		// Billing and fleet views both read this; recording a degraded join as
		// ready would overstate the mesh.
		const events: Record<string, unknown>[] = [];
		await overlay(
			{ "status --json": fail() },
			{ metering: { emit: async (e: never) => events.push(e) } },
		).net.join(join());
		expect(
			(events[0]?.metadata as Record<string, unknown> | undefined)?.ready,
		).toBe(false);
	});
});

describe("policy", () => {
	const denying = {
		evaluate: async () => ({ effect: "deny", reasons: ["tenant not allowed"] }),
	};
	const allowing = { evaluate: async () => ({ effect: "allow", reasons: [] }) };

	it("refuses a denied join before touching the CLI", async () => {
		// The CLI call is the side effect; asking policy first is what makes the
		// denial mean anything.
		const o = overlay({}, { policy: denying });
		const result = await o.net.join(join());
		expect(result.ready).toBe(false);
		expect(o.calls).toHaveLength(0);
	});

	it("carries the policy's reasons back to the caller", async () => {
		const result = await overlay({}, { policy: denying }).net.join(join());
		expect(result.notes).toContain("tenant not allowed");
	});

	it("marks a denied identity as denied rather than inventing a node", async () => {
		const result = await overlay({}, { policy: denying }).net.join(join());
		expect(result.identity.nodeId).toBe("denied");
		expect(result.identity.overlayIps).toEqual([]);
	});

	it("proceeds when policy allows", async () => {
		expect(
			(await overlay({}, { policy: allowing }).net.join(join())).ready,
		).toBe(true);
	});
});

describe("status and leave", () => {
	it("reports nothing before a join", async () => {
		expect(await overlay().net.status()).toBeNull();
	});

	it("reports the joined identity", async () => {
		const o = overlay();
		await o.net.join(join());
		expect((await o.net.status())?.nodeId).toBe("node-abc");
	});

	it("forgets the identity on leave", async () => {
		const o = overlay();
		await o.net.join(join());
		await o.net.leave();
		expect(await o.net.status()).toBeNull();
	});

	it("meters a leave", async () => {
		const events: Record<string, unknown>[] = [];
		const o = overlay(
			{},
			{ metering: { emit: async (e: never) => events.push(e) } },
		);
		await o.net.join(join());
		await o.net.leave();
		expect(events).toHaveLength(2);
	});

	it("does not meter a leave that never joined", async () => {
		// An unmatched leave event would show a node departing a mesh it never
		// entered.
		const events: unknown[] = [];
		await overlay(
			{},
			{ metering: { emit: async (e: unknown) => events.push(e) } },
		).net.leave();
		expect(events).toEqual([]);
	});
});

describe("MagicDNS split DNS", () => {
	const config = (overrides: Record<string, unknown> = {}) =>
		({
			tenantId: "t1",
			domains: [],
			nameservers: [],
			...overrides,
		}) as never;

	it("applies when the local CLI accepts", async () => {
		const result = await overlay().net.configureMagicDns?.(config());
		expect(result?.applied).toBe(true);
	});

	it("falls back to the default hobo zones", async () => {
		// A caller that names no domain still wants hierarchical hobo names to
		// resolve; an empty split-DNS map would route nothing.
		const result = await overlay().net.configureMagicDns?.(config());
		expect(result?.domains.length).toBeGreaterThan(0);
	});

	it("uses configured default zones", async () => {
		const result = await overlay(
			{},
			{ defaultMagicDnsDomains: ["custom.internal"] },
		).net.configureMagicDns?.(config());
		expect(result?.domains).toEqual(["custom.internal"]);
	});

	it("uses the caller's domains when given", async () => {
		const result = await overlay().net.configureMagicDns?.(
			config({ domains: ["shop.internal"] }),
		);
		expect(result?.domains).toEqual(["shop.internal"]);
	});

	it("reports not-applied when nothing succeeded", async () => {
		// Both the local accept and the control plane failed: claiming applied
		// would have an operator debugging DNS that was never configured.
		const result = await overlay({
			set: fail(),
			"dns --help": fail(),
		}).net.configureMagicDns?.(config());
		expect(result?.applied).toBe(false);
	});

	it("says the control plane was skipped when no API key is set", async () => {
		// Local acceptance only configures this node; the note is what tells an
		// operator the tailnet itself was not updated.
		const previous = process.env.TS_API_KEY;
		delete process.env.TS_API_KEY;
		try {
			const result = await overlay({
				"dns --help": fail(),
			}).net.configureMagicDns?.(config());
			expect(result?.notes.join(" ")).toMatch(/TS_API_KEY.*unset/u);
		} finally {
			if (previous !== undefined) process.env.TS_API_KEY = previous;
		}
	});

	it("skips the CLI dns helpers when the subcommand is unavailable", async () => {
		// Older Tailscale builds have no `dns` subcommand; probing first is what
		// keeps the notes free of spurious failures.
		const o = overlay({ "dns --help": fail() });
		await o.net.configureMagicDns?.(config({ domains: ["a.internal"] }));
		expect(o.ran("dns set")).toBe(false);
	});

	it("uses the CLI dns helpers when they exist", async () => {
		const o = overlay();
		await o.net.configureMagicDns?.(config({ domains: ["a.internal"] }));
		expect(o.ran("dns set")).toBe(true);
	});

	it("records the tenant the split DNS was configured for", async () => {
		const result = await overlay().net.configureMagicDns?.(config());
		expect(result?.notes.join(" ")).toContain("tenant=t1");
	});

	it("meters the configuration", async () => {
		const events: unknown[] = [];
		await overlay(
			{},
			{ metering: { emit: async (e: unknown) => events.push(e) } },
		).net.configureMagicDns?.(config());
		expect(events).toHaveLength(1);
	});
});

describe("Funnel", () => {
	const funnel = (overrides: Record<string, unknown> = {}) =>
		({
			tenantId: "t1",
			backendUrl: "http://127.0.0.1:8080/",
			...overrides,
		}) as never;

	it("publishes a loopback backend", async () => {
		const o = overlay({ funnel: ok("https://laptop.tailnet.ts.net") });
		const result = await o.net.publishFunnel?.(funnel());
		expect(result?.enabled).toBe(true);
		expect(result?.gatewayHostname).toBe("laptop.tailnet.ts.net");
	});

	it("runs Funnel in the background rather than blocking", async () => {
		// A foreground funnel would hold the deploy open forever.
		const o = overlay({ funnel: ok("https://x.ts.net") });
		await o.net.publishFunnel?.(funnel());
		expect(o.ran("funnel --bg")).toBe(true);
	});

	it("refuses a non-local backend without invoking the CLI", async () => {
		// Funnel publishes to the public internet; pointing it at an arbitrary
		// host would proxy something the operator never meant to expose.
		const o = overlay();
		const result = await o.net.publishFunnel?.(
			funnel({ backendUrl: "http://example.com/" }),
		);
		expect(result?.enabled).toBe(false);
		expect(o.ran("funnel")).toBe(false);
		expect(result?.notes.join(" ")).toMatch(/matching local/u);
	});

	it("refuses a non-HTTP scheme", async () => {
		const result = await overlay().net.publishFunnel?.(
			funnel({ backendUrl: "ssh://127.0.0.1:22" }),
		);
		expect(result?.enabled).toBe(false);
	});

	it("refuses a backend that is not a URL at all", async () => {
		const result = await overlay().net.publishFunnel?.(
			funnel({ backendUrl: "not a url" }),
		);
		expect(result?.notes.join(" ")).toMatch(/absolute local/u);
	});

	it("refuses when the named local port does not match the backend", async () => {
		// Publishing 8080 while the service listens on 3000 exposes whatever
		// else happens to be on 8080.
		const result = await overlay().net.publishFunnel?.(
			funnel({ backendUrl: "http://127.0.0.1:8080/", localPort: 3000 }),
		);
		expect(result?.enabled).toBe(false);
	});

	it("accepts a matching explicit port", async () => {
		const result = await overlay({
			funnel: ok("https://x.ts.net"),
		}).net.publishFunnel?.(
			funnel({ backendUrl: "http://127.0.0.1:8080/", localPort: 8080 }),
		);
		expect(result?.enabled).toBe(true);
	});

	it("infers the default port for a scheme with none stated", async () => {
		const result = await overlay({
			funnel: ok("https://x.ts.net"),
		}).net.publishFunnel?.(
			funnel({ backendUrl: "https://localhost/", localPort: 443 }),
		);
		expect(result?.enabled).toBe(true);
	});

	it("accepts a hostnameHint that is a real funnel host", async () => {
		const result = await overlay({ funnel: fail() }).net.publishFunnel?.(
			funnel({ hostnameHint: "laptop.tailnet.ts.net" }),
		);
		expect(result?.gatewayHostname).toBe("laptop.tailnet.ts.net");
	});

	it("rejects a hostnameHint that is not a funnel host", async () => {
		// Accepting a raw IP or arbitrary domain would have HoBo announce a
		// public URL it does not control and cannot serve.
		const result = await overlay({ funnel: fail() }).net.publishFunnel?.(
			funnel({ hostnameHint: "203.0.113.7" }),
		);
		expect(result?.gatewayHostname).toBeNull();
		expect(result?.notes.join(" ")).toMatch(/hostnameHint rejected/u);
	});

	it("does not claim Funnel is enabled on a hint alone", async () => {
		// The hint is a guess at the address, not evidence anything is
		// listening. Reporting enabled would tell an operator their endpoint is
		// public when it is not.
		const result = await overlay({ funnel: fail() }).net.publishFunnel?.(
			funnel({ hostnameHint: "laptop.tailnet.ts.net" }),
		);
		expect(result?.enabled).toBe(false);
		expect(result?.confirmed).toBe(false);
	});

	it("reports confirmed only when the CLI succeeded", async () => {
		const result = await overlay({
			funnel: ok("https://x.ts.net"),
		}).net.publishFunnel?.(funnel());
		expect(result?.confirmed).toBe(true);
	});

	it("says what to do when Funnel is not ready", async () => {
		const result = await overlay({ funnel: fail() }).net.publishFunnel?.(
			funnel(),
		);
		expect(result?.notes.join(" ")).toMatch(
			/enable Funnel in ACL|hostnameHint/u,
		);
	});

	it("keeps the CLI's failure text in the notes", async () => {
		const result = await overlay({
			funnel: fail("funnel not permitted by ACL"),
		}).net.publishFunnel?.(funnel());
		expect(result?.notes.join(" ")).toContain("not permitted by ACL");
	});

	it("finds the gateway in stderr as well as stdout", async () => {
		// Tailscale prints the URL to either depending on version.
		const result = await overlay({
			funnel: { ok: true, stdout: "", stderr: "https://from-stderr.ts.net" },
		}).net.publishFunnel?.(funnel());
		expect(result?.gatewayHostname).toBe("from-stderr.ts.net");
	});

	it("lowercases the gateway hostname", async () => {
		// Hostnames are case-insensitive on the wire but compared as strings
		// downstream.
		const result = await overlay({
			funnel: ok("https://LAPTOP.Tailnet.TS.NET"),
		}).net.publishFunnel?.(funnel());
		expect(result?.gatewayHostname).toBe("laptop.tailnet.ts.net");
	});

	it("reports progress either way", async () => {
		const lines: string[] = [];
		await overlay({ funnel: fail() }).net.publishFunnel?.(
			funnel({ emitProgress: (line: string) => lines.push(line) }),
		);
		expect(lines.join(" ")).toContain("not ready");
	});

	it("still returns a result when metering throws", async () => {
		// A confirmed provider side effect remains authoritative: losing the
		// result because the meter failed would hide a live public endpoint.
		const result = await overlay(
			{ funnel: ok("https://x.ts.net") },
			{
				metering: {
					emit: async () => {
						throw new Error("meter down");
					},
				},
			},
		).net.publishFunnel?.(funnel());
		expect(result?.enabled).toBe(true);
	});
});
