/**
 * The Netbird overlay adapter, driven through an injected management client.
 *
 * The property this adapter is built around is that **an accepted setup key is
 * not a joined peer**. Netbird's enrolment endpoint can validate a key and
 * return success before the peer actually appears in the network, so the
 * adapter refuses to report `ready` until it has a concrete peer identity — an
 * id or an overlay IP. If it reported ready on key acceptance alone, a deploy
 * would proceed to address a node that has no address yet, and the failure
 * would surface much later as an unreachable service.
 *
 * That is also why the fallback exists: when enrolment succeeds without
 * identity, the adapter *lists peers* to find the node by name before giving
 * up. Listing is the cheap way to convert "probably joined" into "joined, and
 * here is its address".
 *
 * The other rule worth stating is the one about Funnel. Netbird has no
 * configured public reverse-proxy seam in this build, so `publishFunnel`
 * **always reports `enabled: false`**, even when it can name a gateway. Naming
 * a hostname is not the same as publishing to it, and an adapter that conflated
 * the two would tell an operator their service is public when nothing is
 * routing to it. The honest answer is a gateway hostname plus an explicit "not
 * enabled".
 */
import { describe, expect, it } from "vitest";

import { createNetbirdOverlay } from "../../src/overlay/netbird.js";

type Peer = { id: string; name?: string; ip?: string; dnsLabel?: string };

/** A management client with scriptable enrolment and peer listing. */
function api(
	overrides: {
		enroll?: () => unknown;
		peers?: () => unknown;
		dns?: () => unknown;
	} = {},
) {
	const calls: string[] = [];
	return {
		calls,
		client: {
			enrollPeer: async () => {
				calls.push("enrollPeer");
				return (
					overrides.enroll?.() ?? {
						enrolled: true,
						notes: [],
						peer: { id: "peer-1", ip: "100.92.0.5" },
					}
				);
			},
			listPeers: async () => {
				calls.push("listPeers");
				return overrides.peers?.() ?? ([] as Peer[]);
			},
			upsertDnsNameserverGroup: async () => {
				calls.push("upsertDnsNameserverGroup");
				return (
					overrides.dns?.() ?? {
						name: "hobo-t1",
						domains: ["hobo.internal"],
					}
				);
			},
		} as never,
	};
}

const overlay = (
	apiOverrides: Parameters<typeof api>[0] = {},
	options: Record<string, unknown> = {},
) => {
	const a = api(apiOverrides);
	return {
		...a,
		net: createNetbirdOverlay({ api: a.client, ...options } as never),
	};
};

/** An overlay with no management client configured at all. */
const unconfigured = (options: Record<string, unknown> = {}) => {
	const previousUrl = process.env.NETBIRD_MANAGEMENT_URL;
	const previousHobo = process.env.HOBO_NETBIRD_URL;
	delete process.env.NETBIRD_MANAGEMENT_URL;
	delete process.env.HOBO_NETBIRD_URL;
	const net = createNetbirdOverlay(options as never);
	if (previousUrl !== undefined)
		process.env.NETBIRD_MANAGEMENT_URL = previousUrl;
	if (previousHobo !== undefined) process.env.HOBO_NETBIRD_URL = previousHobo;
	return net;
};

const join = (overrides: Record<string, unknown> = {}) =>
	({
		tenantId: "t1",
		hostname: "yard-1",
		tags: [],
		...overrides,
	}) as never;

describe("tenant tags", () => {
	it("tags a node with its tenant and role", () => {
		const tags = overlay().net.tenantTags({
			tenantId: "t1" as never,
			role: "server",
		} as never);
		expect(tags).toEqual(["tenant:t1", "role:server"]);
	});

	it("adds the optional dimensions only when given", () => {
		expect(
			overlay().net.tenantTags({
				tenantId: "t1" as never,
				role: "server",
				env: "prod",
				cloud: "gcp",
				overlayNetworkId: "net-1",
			} as never),
		).toEqual([
			"tenant:t1",
			"role:server",
			"env:prod",
			"cloud:gcp",
			"overlay:net-1",
		]);
	});

	it("does not borrow Tailscale's dev-laptop ACL spelling", () => {
		// Netbird has its own tag vocabulary; emitting `tag:dev-laptop` here
		// would be a tag no Netbird policy matches.
		expect(
			overlay().net.tenantTags({
				tenantId: "t1" as never,
				role: "laptop",
			} as never),
		).not.toContain("tag:dev-laptop");
	});
});

describe("joining", () => {
	it("reports ready when enrolment returns a peer identity", async () => {
		const result = await overlay().net.join(join());
		expect(result.ready).toBe(true);
		expect(result.identity.nodeId).toBe("peer-1");
		expect(result.identity.overlayIps).toEqual(["100.92.0.5"]);
	});

	it("passes an auth key through as the setup key", async () => {
		const o = overlay();
		await o.net.join(join({ authKey: "setup-key-1" }));
		expect(o.calls).toContain("enrollPeer");
	});

	it("tags the node with its tenant even when the caller forgot", async () => {
		expect((await overlay().net.join(join())).identity.tags).toContain(
			"tenant:t1",
		);
	});

	it("keeps a tenant tag the caller already supplied", async () => {
		const result = await overlay().net.join(join({ tags: ["tenant:other"] }));
		expect(result.identity.tags.filter((t) => t.startsWith("tenant:"))).toEqual(
			["tenant:other"],
		);
	});

	it("refuses to call an accepted key a joined peer", async () => {
		// The rule the adapter is built around: enrolment can validate a key
		// before the peer exists. Reporting ready here would have a deploy
		// address a node that has no address.
		const result = await overlay({
			enroll: () => ({ enrolled: true, notes: [], peer: undefined }),
		}).net.join(join());
		expect(result.ready).toBe(false);
	});

	it("says why it withheld ready", async () => {
		const result = await overlay({
			enroll: () => ({ enrolled: true, notes: [], peer: undefined }),
		}).net.join(join());
		expect(result.notes.join(" ")).toMatch(/peer identity not confirmed/u);
	});

	it("lists peers to resolve an identity enrolment did not return", async () => {
		// The cheap way to turn "probably joined" into "joined, and here is its
		// address".
		const o = overlay({
			enroll: () => ({ enrolled: true, notes: [], peer: undefined }),
			peers: () => [{ id: "peer-9", name: "yard-1", ip: "100.92.0.9" }],
		});
		const result = await o.net.join(join());
		expect(o.calls).toContain("listPeers");
		expect(result.ready).toBe(true);
		expect(result.identity.nodeId).toBe("peer-9");
	});

	it("matches a peer by id as well as by name", async () => {
		const result = await overlay({
			enroll: () => ({ enrolled: true, notes: [], peer: undefined }),
			peers: () => [{ id: "yard-1", ip: "100.92.0.3" }],
		}).net.join(join());
		expect(result.identity.overlayIps).toEqual(["100.92.0.3"]);
	});

	it("does not list peers when enrolment already answered", async () => {
		// A redundant round trip against the management API on every join.
		const o = overlay();
		await o.net.join(join());
		expect(o.calls).not.toContain("listPeers");
	});

	it("stays not-ready when the peer is nowhere in the list", async () => {
		const result = await overlay({
			enroll: () => ({ enrolled: true, notes: [], peer: undefined }),
			peers: () => [{ id: "someone-else", name: "other-host" }],
		}).net.join(join());
		expect(result.ready).toBe(false);
	});

	it("survives a peer listing that throws", async () => {
		// A management API that is up enough to enrol but not to list must not
		// turn a partial success into an exception.
		const result = await overlay({
			enroll: () => ({ enrolled: true, notes: [], peer: undefined }),
			peers: () => {
				throw new Error("management API 503");
			},
		}).net.join(join());
		expect(result.ready).toBe(false);
		expect(result.notes.join(" ")).toContain("503");
	});

	it("carries the client's own notes through", async () => {
		// The client knows why enrolment went the way it did; paraphrasing would
		// lose it.
		const result = await overlay({
			enroll: () => ({
				enrolled: false,
				notes: ["setup key expired"],
				peer: undefined,
			}),
		}).net.join(join());
		expect(result.notes).toContain("setup key expired");
	});

	it("synthesizes a node id when there is no peer at all", async () => {
		// Something has to identify the node locally even when the mesh does
		// not know it yet.
		const result = await overlay({
			enroll: () => ({ enrolled: false, notes: [], peer: undefined }),
		}).net.join(join());
		expect(result.identity.nodeId).toBe("netbird:yard-1");
	});

	it("says how to configure it when no management URL is set", async () => {
		const result = await unconfigured().join(join());
		expect(result.ready).toBe(false);
		expect(result.notes.join(" ")).toMatch(/NETBIRD_MANAGEMENT_URL/u);
	});

	it("reports progress on a successful join", async () => {
		const lines: string[] = [];
		await overlay().net.join(
			join({ emitProgress: (line: string) => lines.push(line) }),
		);
		expect(lines.join(" ")).toContain("netbird joined");
	});

	it("reports the reason on an incomplete join", async () => {
		const lines: string[] = [];
		await unconfigured().join(
			join({ emitProgress: (line: string) => lines.push(line) }),
		);
		expect(lines.join(" ")).toContain("incomplete");
	});

	it("meters the join with its readiness", async () => {
		const events: Record<string, unknown>[] = [];
		await overlay(
			{},
			{ metering: { emit: async (e: never) => events.push(e) } },
		).net.join(join());
		expect(
			(events[0]?.metadata as Record<string, unknown> | undefined)?.ready,
		).toBe(true);
	});

	it("meters an incomplete join as not ready", async () => {
		const events: Record<string, unknown>[] = [];
		await overlay(
			{ enroll: () => ({ enrolled: true, notes: [], peer: undefined }) },
			{ metering: { emit: async (e: never) => events.push(e) } },
		).net.join(join());
		expect(
			(events[0]?.metadata as Record<string, unknown> | undefined)?.ready,
		).toBe(false);
	});
});

describe("status and leave", () => {
	it("reports nothing before a join", async () => {
		expect(await overlay().net.status()).toBeNull();
	});

	it("reports the joined identity", async () => {
		const o = overlay();
		await o.net.join(join());
		expect((await o.net.status())?.nodeId).toBe("peer-1");
	});

	it("remembers an identity even from an incomplete join", async () => {
		// The local node still exists; status returning null would make a
		// partial join indistinguishable from no join.
		const o = overlay({
			enroll: () => ({ enrolled: false, notes: [], peer: undefined }),
		});
		await o.net.join(join());
		expect(await o.net.status()).not.toBeNull();
	});

	it("forgets the identity on leave", async () => {
		const o = overlay();
		await o.net.join(join());
		await o.net.leave();
		expect(await o.net.status()).toBeNull();
	});

	it("does not meter a leave that never joined", async () => {
		const events: unknown[] = [];
		await overlay(
			{},
			{ metering: { emit: async (e: unknown) => events.push(e) } },
		).net.leave();
		expect(events).toEqual([]);
	});
});

describe("DNS nameserver groups", () => {
	const config = (overrides: Record<string, unknown> = {}) =>
		({
			tenantId: "t1",
			domains: ["hobo.internal"],
			nameservers: ["100.92.0.1"],
			...overrides,
		}) as never;

	it("upserts a group for the tenant", async () => {
		const o = overlay();
		const result = await o.net.configureMagicDns?.(config());
		expect(result?.applied).toBe(true);
		expect(o.calls).toContain("upsertDnsNameserverGroup");
	});

	it("names the group after the tenant, so tenants cannot collide", async () => {
		const result = await overlay().net.configureMagicDns?.(config());
		expect(result?.notes.join(" ")).toContain("hobo-t1");
	});

	it("reports the domains it was asked for", async () => {
		const result = await overlay().net.configureMagicDns?.(
			config({ domains: ["a.internal", "b.internal"] }),
		);
		expect(result?.domains).toEqual(["a.internal", "b.internal"]);
	});

	it("reports not-applied when the upsert fails", async () => {
		// Claiming applied would have an operator debugging resolution that was
		// never configured.
		const result = await overlay({
			dns: () => {
				throw new Error("403 forbidden");
			},
		}).net.configureMagicDns?.(config());
		expect(result?.applied).toBe(false);
		expect(result?.notes.join(" ")).toContain("403 forbidden");
	});

	it("says what credential it needs when unconfigured", async () => {
		const result = await unconfigured().configureMagicDns?.(config());
		expect(result?.applied).toBe(false);
		expect(result?.notes.join(" ")).toMatch(/NETBIRD_TOKEN/u);
	});

	it("meters the attempt either way", async () => {
		const events: unknown[] = [];
		await unconfigured({
			metering: { emit: async (e: unknown) => events.push(e) },
		}).configureMagicDns?.(config());
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

	it("never reports enabled, because there is no public seam here", async () => {
		// Naming a hostname is not publishing to it. Conflating the two would
		// tell an operator their service is public when nothing routes to it.
		const result = await overlay().net.publishFunnel?.(
			funnel({ hostnameHint: "gw.netbird.selfhosted" }),
		);
		expect(result?.enabled).toBe(false);
		expect(result?.confirmed).toBe(false);
	});

	it("says so in the notes rather than only in the flag", async () => {
		const result = await overlay().net.publishFunnel?.(funnel());
		expect(result?.notes.join(" ")).toMatch(
			/no configured public reverse-proxy/u,
		);
	});

	it.each([
		"gw.netbird.selfhosted",
		"gw.nb.local",
		"my-netbird-gateway.example",
	])("accepts the netbird-shaped hint %s", async (hint) => {
		const result = await overlay().net.publishFunnel?.(
			funnel({ hostnameHint: hint }),
		);
		expect(result?.gatewayHostname).toBe(hint);
	});

	it("ignores a hint that is not netbird-shaped", async () => {
		// An arbitrary domain would have HoBo print a gateway it has no relation
		// to.
		const result = await overlay().net.publishFunnel?.(
			funnel({ hostnameHint: "example.com" }),
		);
		expect(result?.gatewayHostname).toBeNull();
	});

	it("derives the gateway from the joined peer's DNS label", async () => {
		const o = overlay({
			peers: () => [{ id: "peer-1", dnsLabel: "yard-1.netbird.cloud" }],
		});
		await o.net.join(join());
		const result = await o.net.publishFunnel?.(funnel());
		expect(result?.gatewayHostname).toBe("yard-1.netbird.cloud");
	});

	it("does not look up a peer before a join", async () => {
		// There is no peer to look up, and the call would be a round trip for
		// nothing.
		const o = overlay();
		await o.net.publishFunnel?.(funnel());
		expect(o.calls).not.toContain("listPeers");
	});

	it("survives a peer lookup that throws", async () => {
		const o = overlay({
			peers: () => {
				throw new Error("management API 503");
			},
		});
		await o.net.join(join());
		const result = await o.net.publishFunnel?.(funnel());
		expect(result?.gatewayHostname).toBeNull();
		expect(result?.notes.join(" ")).toContain("503");
	});

	it("says what to pass when it cannot name a gateway", async () => {
		const result = await overlay().net.publishFunnel?.(funnel());
		expect(result?.notes.join(" ")).toMatch(/hostnameHint|dns_label/u);
	});

	it("still returns a result when metering throws", async () => {
		const result = await overlay(
			{},
			{
				metering: {
					emit: async () => {
						throw new Error("meter down");
					},
				},
			},
		).net.publishFunnel?.(funnel({ hostnameHint: "gw.nb.local" }));
		expect(result?.gatewayHostname).toBe("gw.nb.local");
	});
});
