/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: contract test reads a controlled pact file and recorded exchanges. */
// PACT for the agent ↔ delivery-feed boundary (WP11 Accept: every route and
// error). The consumer is the real agent HTTP transport; the provider is the
// real feed handler over the test Station double. Each interaction runs its
// provider state, drives the consumer, and verifies the recorded exchange:
// method, path, required request headers/body keys/query keys, response
// status, content type, and envelope (ok, value subset, refusal code with a
// remediation).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ReconcileStatus } from "../src/_generated/cd_pb.js";
import { createDpopProof, createHttpTransport, generateAgentKey } from "../src/agent/index.js";
import { FEED_ROUTES } from "../src/feed/index.js";
import { asCamp, resolvedFor } from "../test/feed/fakes.js";
import { BASE_URL, collect, createStation, type Exchange, observation, provisionAgent, type Station } from "../test/feed/harness.js";

type Interaction = {
	description: string;
	providerState: string;
	request: { method: string; path: string; headers: string[]; body?: string[]; query?: string[] };
	response: {
		status: number;
		contentType: string;
		body?: { ok: boolean; code?: string; value?: Record<string, unknown> };
		sse?: string[];
		matchingRules?: Record<string, { match: string; regex: string }>;
	};
};

const pact: { consumer: { name: string }; provider: { name: string }; interactions: Interaction[] } = JSON.parse(
	readFileSync(new URL("./feed.pact.json", import.meta.url), "utf8"),
);

const signal = () => new AbortController().signal;

async function claimed(station: Station) {
	await station.desired.publish("eu-1", resolvedFor("eu-1"));
	const agent = await provisionAgent(station);
	const lease = await agent.transport.claim({ reconcilerId: agent.reconcilerId, campId: asCamp("eu-1"), holderId: "h", ttlMs: 30_000 });
	if (!lease.ok) throw new Error(lease.reasons[0]?.code);
	return { ...agent, lease: lease.value };
}

function last(station: Station, route: string): Exchange {
	const found = [...station.exchanges].reverse().find((x) => new URL(x.request.url).pathname.startsWith(route));
	if (!found) throw new Error(`no exchange for ${route}`);
	return found;
}

/** Provider states + consumer actions, keyed by interaction description. */
const scenarios: Record<string, (station: Station) => Promise<Exchange>> = {
	"an agent enrolls its public key with a bootstrap token": async (s) => {
		await provisionAgent(s, { grants: "none" });
		return last(s, FEED_ROUTES.enrollments);
	},
	"a used bootstrap token is refused": async (s) => {
		await provisionAgent(s, { grants: "none" });
		const used = JSON.parse(last(s, FEED_ROUTES.enrollments).request.body ?? "{}").token;
		await s.http({
			method: "POST",
			url: `${BASE_URL}${FEED_ROUTES.enrollments}`,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: used, publicJwk: generateAgentKey().publicJwk, claims: [] }),
			timeoutMs: 1000,
			maxResponseBytes: 1_000_000,
		});
		return last(s, FEED_ROUTES.enrollments);
	},
	"activation with only one enrollment grant is refused": async (s) => {
		const { transport, reconcilerId } = await provisionAgent(s, { grants: "key-only" });
		await transport.claim({ reconcilerId, campId: asCamp("eu-1"), holderId: "h", ttlMs: 1000 });
		return last(s, FEED_ROUTES.svidRefresh);
	},
	"an accepted agent activates a key-bound SVID by key possession": async (s) => {
		await claimed(s);
		return s.exchanges.find((x) => x.request.url.endsWith(FEED_ROUTES.svidRefresh)) as Exchange;
	},
	"an agent refreshes its SVID before expiry": async (s) => {
		const { transport, lease } = await claimed(s);
		s.clock.advance(11 * 60_000);
		await transport.renew(lease);
		return last(s, FEED_ROUTES.svidRefresh);
	},
	"an agent claims the per-Camp lease": async (s) => {
		await claimed(s);
		return last(s, FEED_ROUTES.leases);
	},
	"a second reconciler is refused while the lease is held": async (s) => {
		await claimed(s);
		const b = await provisionAgent(s);
		await b.transport.claim({ reconcilerId: b.reconcilerId, campId: asCamp("eu-1"), holderId: "h", ttlMs: 1000 });
		return last(s, FEED_ROUTES.leases);
	},
	"a Camp the agent is not accepted for is refused": async (s) => {
		const { transport, reconcilerId } = await provisionAgent(s, { campIds: ["eu-1"] });
		await transport.claim({ reconcilerId, campId: asCamp("eu-2"), holderId: "h", ttlMs: 1000 });
		return last(s, FEED_ROUTES.leases);
	},
	"an agent renews its lease": async (s) => {
		const { transport, lease } = await claimed(s);
		await transport.renew(lease);
		return last(s, FEED_ROUTES.leaseRenew);
	},
	"a revoked agent is refused on its next request": async (s) => {
		const { transport, lease, reconcilerId } = await claimed(s);
		await s.enrollment.revoke(reconcilerId, "test", { tenant: "acme", principal: { kind: "user", id: "alice" }, now: s.clock.now });
		await transport.renew(lease);
		return last(s, FEED_ROUTES.leaseRenew);
	},
	"an agent releases its lease": async (s) => {
		const { transport, lease } = await claimed(s);
		await transport.release(lease);
		return last(s, FEED_ROUTES.leaseRelease);
	},
	"the feed streams DeliveryFeedFrames and ends cleanly": async (s) => {
		const { transport, lease } = await claimed(s);
		await collect(transport.feed({ lease, signal: signal() }));
		return last(s, FEED_ROUTES.feed);
	},
	"a replayed DPoP proof is refused": async (s) => {
		const { transport, lease } = await claimed(s);
		await collect(transport.feed({ lease, signal: signal() }));
		const served = last(s, FEED_ROUTES.feed);
		await s.http({ ...served.request, headers: Object.fromEntries(Object.entries(served.request.headers).filter(([k]) => k !== "last-event-id")) });
		return last(s, FEED_ROUTES.feed);
	},
	"a stolen SVID presented with another key is refused": async (s) => {
		const { reconcilerId } = await claimed(s);
		const svid = String(last(s, FEED_ROUTES.leases).request.headers.authorization).replace(/^DPoP /u, "");
		const thief = createHttpTransport({ baseUrl: BASE_URL, http: s.http, reconcilerId, privateJwk: generateAgentKey().privateJwk, svid, now: s.clock.now });
		await thief.claim({ reconcilerId, campId: asCamp("eu-1"), holderId: "h", ttlMs: 1000 });
		return last(s, FEED_ROUTES.leases);
	},
	"a request without an SVID is refused": async (s) => {
		await s.http({ method: "POST", url: `${BASE_URL}${FEED_ROUTES.leases}`, headers: { "content-type": "application/json" }, body: "{}", timeoutMs: 1000, maxResponseBytes: 1000 });
		return last(s, FEED_ROUTES.leases);
	},
	"an agent fetches a resolved-set blob by digest": async (s) => {
		const set = await s.desired.publish("eu-1", resolvedFor("eu-1", ["big"], 300_000));
		const { transport, reconcilerId } = await provisionAgent(s);
		const lease = await transport.claim({ reconcilerId, campId: asCamp("eu-1"), holderId: "h", ttlMs: 30_000 });
		if (!lease.ok) throw new Error("claim");
		await transport.resolved(lease.value, set);
		return last(s, FEED_ROUTES.blobs);
	},
	"a missing blob is a typed refusal": async (s) => {
		const set = await s.desired.publish("eu-1", resolvedFor("eu-1", ["big"], 300_000), { storeBlob: false });
		const { transport, reconcilerId } = await provisionAgent(s);
		const lease = await transport.claim({ reconcilerId, campId: asCamp("eu-1"), holderId: "h", ttlMs: 30_000 });
		if (!lease.ok) throw new Error("claim");
		await transport.resolved(lease.value, set);
		return last(s, FEED_ROUTES.blobs);
	},
	"an agent reports an observation to the Camp status stream": async (s) => {
		const { transport, lease } = await claimed(s);
		const set = await s.desired.current(asCamp("eu-1"));
		if (!set) throw new Error("set");
		await transport.report(lease, observation(lease, set, ReconcileStatus.CONVERGED));
		return last(s, FEED_ROUTES.observations);
	},
	"a report with a stale fence is refused": async (s) => {
		const a = await claimed(s);
		s.clock.advance(31_000);
		const b = await provisionAgent(s);
		await b.transport.claim({ reconcilerId: b.reconcilerId, campId: asCamp("eu-1"), holderId: "h", ttlMs: 30_000 });
		const set = await s.desired.current(asCamp("eu-1"));
		if (!set) throw new Error("set");
		await a.transport.report(a.lease, observation(a.lease, set, ReconcileStatus.CONVERGED));
		return last(s, FEED_ROUTES.observations);
	},
	"an agent commits a checkpoint": async (s) => {
		const { transport, lease } = await claimed(s);
		await transport.checkpoint(lease, 1n as never);
		return last(s, FEED_ROUTES.checkpoints);
	},
	"a checkpoint behind the committed one is refused": async (s) => {
		const { transport, lease } = await claimed(s);
		await transport.checkpoint(lease, 3n as never);
		await transport.checkpoint(lease, 2n as never);
		return last(s, FEED_ROUTES.checkpoints);
	},
};

function subset(actual: Record<string, unknown>, expected: Record<string, unknown>, rules: Interaction["response"]["matchingRules"], path: string) {
	for (const [key, value] of Object.entries(expected)) {
		const at = `${path}.${key}`;
		const rule = rules?.[at];
		if (rule) expect(String(actual[key]), at).toMatch(new RegExp(rule.regex, "u"));
		else if (value !== null && typeof value === "object") subset((actual[key] ?? {}) as Record<string, unknown>, value as Record<string, unknown>, rules, at);
		else if (key === "state") expect(String(actual[key]), at).toContain(String(value));
		else if (typeof value === "number" && value === 0) expect(typeof actual[key], at).toBe("number");
		else if (value === "<jwt>") expect(String(actual[key]), at).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/u);
		else expect(actual[key], at).toEqual(value);
	}
}

describe(`PACT ${pact.consumer.name} → ${pact.provider.name}`, () => {
	it("covers every feed route", () => {
		const paths = new Set(pact.interactions.map((i) => i.request.path.replace("{digest}", "")));
		for (const route of Object.values(FEED_ROUTES)) expect(paths, route).toContain(route);
		expect(Object.keys(scenarios).sort()).toEqual(pact.interactions.map((i) => i.description).sort());
	});

	for (const interaction of pact.interactions) {
		it(`${interaction.description} (given ${interaction.providerState})`, async () => {
			const station = createStation({ camps: ["eu-1", "eu-2"], longPollMs: 30, heartbeatMs: 10 });
			const scenario = scenarios[interaction.description];
			if (!scenario) throw new Error("no scenario");
			const exchange = await scenario(station);
			const url = new URL(exchange.request.url);
			expect(exchange.request.method).toBe(interaction.request.method);
			const path = interaction.request.path.includes("{digest}") ? interaction.request.path.replace("{digest}", "") : interaction.request.path;
			if (interaction.request.path.includes("{digest}")) expect(url.pathname.startsWith(path)).toBe(true);
			else expect(url.pathname).toBe(path);
			for (const header of interaction.request.headers) expect(Object.keys(exchange.request.headers), header).toContain(header);
			const body = exchange.request.body ? JSON.parse(exchange.request.body) : {};
			for (const key of interaction.request.body ?? []) expect(Object.keys(body), key).toContain(key);
			for (const key of interaction.request.query ?? []) expect([...url.searchParams.keys()], key).toContain(key);
			expect(exchange.status).toBe(interaction.response.status);
			const response = interaction.response;
			if (response.sse) {
				for (const event of response.sse) expect(exchange.body).toContain(`event: ${event}`);
				return;
			}
			if (!response.body) return;
			const envelope = JSON.parse(exchange.body);
			expect(envelope.ok).toBe(response.body.ok);
			if (response.body.code) {
				expect(envelope.reasons[0].code).toBe(response.body.code);
				expect(envelope.reasons[0].remediation.length).toBeGreaterThan(0);
			}
			if (response.body.value) subset(envelope.value, response.body.value, response.matchingRules, "$.body.value");
		});
	}

	it("DPoP proofs on the wire bind htm/htu and are single use", () => {
		const key = generateAgentKey();
		const proof = createDpopProof({ privateJwk: key.privateJwk, method: "GET", url: `${BASE_URL}/v1/cd/feed?camp=eu-1`, iatSeconds: 1, jti: "a" });
		const payload = JSON.parse(Buffer.from(proof.split(".")[1] ?? "", "base64url").toString("utf8"));
		expect(payload).toMatchObject({ htm: "GET", htu: `${BASE_URL}/v1/cd/feed`, jti: "a" });
	});
});
