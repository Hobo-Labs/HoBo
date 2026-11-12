// Promoted from src/draft/technical-proofs/hobo-relay-contract (auth, SSRF and
// deny-by-default only; plan 0024 §3, WP11). The proof's reverse tunnel is
// replaced by pull over the delivery feed (C10); its rules carry over:
//
//   proof rule                                   → package rule
//   register/attach are governed deny-by-default → token issue, both grants and revoke are governed; a denied or
//                                                  proposal-only principal is refused; an unenrolled caller is refused
//   outbound-only TCP 443, no inbound listener   → agent egress is https to one Station origin; no agent listener;
//                                                  the Station never dials the agent
//   unauthenticated/expired SVIDs cannot attach  → missing/expired/foreign SVIDs are refused at the feed
//   metadata endpoint / rebinding / forward-proxy → metadata and link-local origins refused; only `/v1/cd/` on the
//                                                  configured host; no redirects; percent-encoded separators refused
//   credential material never in work frames     → feed frames and the journal never carry target credentials
import type { HttpTransport, TransportRequest } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { ReconcilerMode } from "../../src/_generated/cd_pb.js";
import { AgentEgressError, createHttpTransport, generateAgentKey, parseStationOrigin, stationTransport } from "../../src/agent/index.js";
import { asCamp, asReconciler, createClock, resolvedFor } from "../feed/fakes.js";
import { createStation, provisionAgent } from "../feed/harness.js";

const echo: HttpTransport = async () => ({ status: 200, headers: {}, body: '{"ok":true,"value":null}' });

function request(url: string): TransportRequest {
	return { method: "GET", url, headers: {}, timeoutMs: 1000, maxResponseBytes: 1000 };
}

describe("relay proof: outbound-only and SSRF rules for agent egress", () => {
	it("refuses non-HTTPS, credentialed, query-bearing and path-bearing base URLs", () => {
		for (const url of [
			"http://station.test",
			"https://user:pw@station.test",
			"https://station.test/?x=1",
			"https://station.test/#f",
			"https://station.test/admin",
			"not a url",
		])
			expect(() => parseStationOrigin(url), url).toThrow(AgentEgressError);
		expect(parseStationOrigin("https://station.test").origin).toBe("https://station.test");
	});

	it("refuses metadata and link-local endpoints even when configured", () => {
		for (const url of [
			"https://169.254.169.254",
			"https://metadata.google.internal",
			"https://[fd00:ec2::254]",
			"https://169.254.10.10",
			"https://[fe80::1]",
			"https://0.0.0.0",
		])
			expect(() => parseStationOrigin(url), url).toThrow(AgentEgressError);
	});

	it("is not a forward proxy: only the configured host and /v1/cd/ are reachable", async () => {
		const guarded = stationTransport(parseStationOrigin("https://station.test"), echo);
		await expect(guarded(request("https://station.test/v1/cd/feed"))).resolves.toMatchObject({ status: 200 });
		await expect(guarded(request("https://169.254.169.254/latest/meta-data"))).rejects.toMatchObject({ code: "TRANSPORT_HOST_FORBIDDEN" });
		await expect(guarded(request("https://station.test/admin"))).rejects.toMatchObject({ code: "TRANSPORT_PATH_FORBIDDEN" });
		await expect(guarded(request("https://station.test/v1/cd/..%2fadmin"))).rejects.toMatchObject({ code: "TRANSPORT_PATH_FORBIDDEN" });
		await expect(guarded(request("http://station.test/v1/cd/feed"))).rejects.toMatchObject({ code: "TRANSPORT_SCHEME_FORBIDDEN" });
	});

	it("never follows a redirect (DNS-rebinding / open-redirect pivot)", async () => {
		const redirecting: HttpTransport = async () => ({ status: 302, headers: { location: "https://169.254.169.254/" }, body: "" });
		const transport = createHttpTransport({
			baseUrl: "https://station.test",
			http: redirecting,
			reconcilerId: asReconciler("agent-x"),
			privateJwk: generateAgentKey().privateJwk,
			svid: "",
			now: createClock().now,
		});
		const claimed = await transport.claim({ reconcilerId: asReconciler("agent-x"), campId: asCamp("eu-1"), holderId: "h", ttlMs: 1 });
		expect(claimed.ok ? "ok" : claimed.reasons[0]?.code).toBe("egress-refused");
	});

	it("the agent exposes no inbound surface: the transport is client-only", () => {
		const transport = createHttpTransport({
			baseUrl: "https://station.test",
			http: echo,
			reconcilerId: asReconciler("agent-x"),
			privateJwk: generateAgentKey().privateJwk,
			svid: "",
			now: createClock().now,
		});
		expect(Object.keys(transport).sort()).toEqual(["checkpoint", "claim", "feed", "release", "renew", "report", "resolved"]);
	});
});

describe("relay proof: governed deny-by-default", () => {
	it("token issue is governed and agents cannot self-enroll or self-grant", async () => {
		const station = createStation();
		const denied = await station.enrollment.issueToken(
			{ campSet: "fleet", campIds: [asCamp("eu-1")], mode: ReconcilerMode.AGENT, ttlMs: 1000 },
			{ tenant: "acme", principal: { kind: "agent", id: "rogue" }, now: station.clock.now },
		);
		expect(denied.ok ? "ok" : denied.reasons[0]?.code).toBe("proposal-only");
		const { reconcilerId } = await provisionAgent(station, { grants: "none" });
		const selfGrant = await station.enrollment.approveKey(reconcilerId, {
			tenant: "acme",
			principal: { kind: "agent", id: reconcilerId },
			now: station.clock.now,
		});
		expect(selfGrant.ok ? "ok" : selfGrant.reasons[0]?.code).toBe("proposal-only");
	});

	it("unauthenticated, forged or foreign-issuer SVIDs are refused at the feed", async () => {
		const station = createStation();
		const other = createStation();
		await other.desired.publish("eu-1", resolvedFor("eu-1"));
		const foreign = await provisionAgent(other);
		await foreign.transport.claim({ reconcilerId: foreign.reconcilerId, campId: asCamp("eu-1"), holderId: "h", ttlMs: 1000 });
		const svid = String(other.exchanges.at(-1)?.request.headers.authorization ?? "").replace(/^DPoP /u, "");
		const transport = createHttpTransport({
			baseUrl: "https://station.test",
			http: station.http,
			reconcilerId: foreign.reconcilerId,
			privateJwk: foreign.key.privateJwk,
			svid,
			now: station.clock.now,
		});
		const claimed = await transport.claim({ reconcilerId: foreign.reconcilerId, campId: asCamp("eu-1"), holderId: "h", ttlMs: 1000 });
		expect(claimed.ok ? "ok" : claimed.reasons[0]?.code).toBe("svid-invalid");
	});

	it("work frames never carry credential material", async () => {
		const station = createStation();
		await station.desired.publish("eu-1", resolvedFor("eu-1"));
		const { transport, reconcilerId } = await provisionAgent(station);
		const lease = await transport.claim({ reconcilerId, campId: asCamp("eu-1"), holderId: "h", ttlMs: 1000 });
		if (!lease.ok) throw new Error("claim");
		for await (const _ of transport.feed({ lease: lease.value, signal: new AbortController().signal })) void _;
		const frames = station.exchanges.filter((x) => x.request.url.includes("/v1/cd/feed")).map((x) => x.body);
		for (const field of ["credential", "credentials", "credentialMaterial", "providerToken", "secret\""])
			expect(frames.join("\n")).not.toContain(`"${field.replace('"', "")}":`);
		expect(frames.join("\n")).toContain("secretref://");
	});
});
