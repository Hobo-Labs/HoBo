/**
 * The failure matrix over a pact, against the drivers that ship.
 *
 * Replaces a lane that faulted one call, drove a hand-written `upsert` rather
 * than the product, and reported that a pact could not prove convergence. The
 * last was my own wrong conclusion: it generalised from the name-filtered
 * lookup (recorded only pre-create, `result: []`) to the whole document, which
 * also records `list all zone records` holding `rec1`. Both states were there;
 * only the sequencing was missing.
 *
 * Asserted, both computed from the pact: **convergence** (after a failure
 * anywhere, a retry lands one record, never creates against a record shown to
 * exist, never concludes "absent" from a read that failed) and **fidelity**
 * (every request sent while recovering has a recorded path, body and headers).
 *
 * Bound: these pacts are hand-authored consumer expectations. This proves the
 * drivers honour the contract the repo agreed on, not that the live API matches.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createCloudflareDnsProvider,
	createCloudflareTrafficRouting,
} from "@hobo/connectivity";
import type { PactDocument } from "@hobo/contract-harness";
import {
	createMockProviderFromPact,
	loadPactDirectory,
} from "@hobo/contract-harness";
import { parseRoutingPlan, parseTenantId } from "@hobo/core";
import {
	type PactChaosSubject,
	type PactLifecycle,
	PactLifecycleError,
	type PactWorld,
	pactBackedTransport,
	pactChaosViolations,
	runPactChaosMatrix,
	statelessPactAnswer,
	WRITE_REACHING_FAULTS,
} from "@hobo/testing";
import { beforeAll, describe, expect, it } from "vitest";

const CONTRACTS_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../connectivity/contracts/pacts",
);

const ZONE = "example.com";
const RECORD = "web.myapp.hobo.example.com";
const TENANT = parseTenantId("acme");

/**
 * The lifecycle, written entirely in terms of interactions the pact already
 * contains — every `answers` value is a recorded interaction's description, so
 * no response body originates here.
 *
 * The two overrides are the whole point. Without them the world answers each
 * request identically forever: an unfiltered list would report `rec1` before
 * anything was created, and a filtered lookup would report empty forever after.
 * Both directions are wrong, and the second is the one that makes a convergence
 * assertion meaningless.
 */
const DNS_LIFECYCLE: PactLifecycle = {
	initial: "absent",
	created: "present",
	creates: ["POST /v4/zones/zone-1/dns_records"],
	answers: {
		absent: {
			"GET /v4/zones/zone-1/dns_records?per_page=100": "list dns records empty",
		},
		present: {
			[`GET /v4/zones/zone-1/dns_records?type=CNAME&name=${RECORD}`]:
				"list all zone records",
		},
	},
	transitions: {
		"POST /v4/zones/zone-1/dns_records": "present",
		"PUT /v4/zones/zone-1/dns_records/rec1": "present",
		"DELETE /v4/zones/zone-1/dns_records/rec1": "absent",
	},
};

/** The transport envelope every direct call in this file repeats. */
function call(
	world: PactWorld,
	method: "GET" | "POST" | "PUT" | "DELETE",
	url: string,
	extra: { headers?: Readonly<Record<string, string>>; body?: string } = {},
) {
	return world.transport({
		method,
		url,
		headers: extra.headers ?? {},
		timeoutMs: 5_000,
		maxResponseBytes: 65_536,
		...(extra.body !== undefined ? { body: extra.body } : undefined),
	});
}

let dnsPact: PactDocument;
let lbPact: PactDocument;

beforeAll(async () => {
	const pacts = await loadPactDirectory(CONTRACTS_DIR);
	const dns = pacts.find((p) => p.provider.name === "CloudflareDnsApi");
	const lb = pacts.find(
		(p) => p.provider.name === "CloudflareLoadBalancingApi",
	);
	if (!dns) throw new Error("CloudflareDnsApi pact not found");
	if (!lb) throw new Error("CloudflareLoadBalancingApi pact not found");
	dnsPact = dns;
	lbPact = lb;
});

function subject(): PactChaosSubject {
	return {
		label: "cloudflare-dns/createCloudflareDnsProvider",
		lifecycle: DNS_LIFECYCLE,
		world: (lifecycle) => pactBackedTransport(dnsPact, { lifecycle }),
		bind: ({ fetchImpl }) => {
			const provider = createCloudflareDnsProvider({
				apiToken: "test-token",
				zoneId: "zone-1",
				apiBase: "https://api.cloudflare.com/v4",
				fetchImpl,
			});
			return {
				converge: async () => {
					await provider.upsert(TENANT, ZONE, {
						name: RECORD,
						type: "CNAME",
						content: "funnel.ts.net",
						gatewayTarget: true,
						ttl: 300,
					});
				},
				observe: async () => provider.list(TENANT, ZONE),
				remove: async () => {
					await provider.remove(TENANT, ZONE, RECORD, "CNAME");
				},
			};
		},
	};
}

describe("the pact-backed world sequences states without inventing responses", () => {
	it("agrees with the stateless mock in its initial state", async () => {
		// The stateful path must be an extension of the repo's existing matching
		// semantics, not a second matcher that drifts from it. Every recorded
		// request gets the same answer from both, before any transition fires.
		for (const interaction of dnsPact.interactions) {
			const world = pactBackedTransport(dnsPact, { lifecycle: DNS_LIFECYCLE });
			const stateless = await statelessPactAnswer(dnsPact, interaction.request);
			const stateful = await call(
				world,
				interaction.request.method,
				`https://api.cloudflare.com${interaction.request.path}`,
				interaction.request.body !== undefined
					? { body: JSON.stringify(interaction.request.body) }
					: {},
			);
			// The two state-dependent reads are exactly the ones expected to differ.
			const overridden =
				DNS_LIFECYCLE.answers.absent?.[
					`${interaction.request.method} ${interaction.request.path}`
				] !== undefined;
			if (overridden) continue;
			expect(stateful.status).toBe(stateless.status);
		}
	});

	it("reports absent before the create and present after it", async () => {
		const world = pactBackedTransport(dnsPact, { lifecycle: DNS_LIFECYCLE });
		const run = subject().bind({
			transport: world.transport,
			fetchImpl: world.fetchImpl,
		});

		expect(await run.observe()).toHaveLength(0);
		await run.converge();
		expect(world.state()).toBe("present");
		expect(await run.observe()).toHaveLength(1);
		expect(world.countUnmatched()).toBe(0);
		expect(world.fidelityViolations()).toEqual([]);
	});

	it("refuses a lifecycle that names an interaction the pact lacks", () => {
		expect(() =>
			pactBackedTransport(dnsPact, {
				lifecycle: {
					...DNS_LIFECYCLE,
					answers: {
						absent: {
							"GET /v4/zones/zone-1/dns_records?per_page=100": "no such thing",
						},
					},
				},
			}),
		).toThrow(PactLifecycleError);
	});

	it("refuses a substitution that would answer a filtered read with an excluded record", () => {
		// The honesty check. Answering the A-record query with the CNAME
		// collection would be a lie the harness told on the driver's behalf, and
		// it is the one shortcut this design could take silently.
		const widened: PactDocument = {
			...dnsPact,
			interactions: [
				...dnsPact.interactions,
				{
					description: "list a records empty",
					request: {
						method: "GET",
						path: `/v4/zones/zone-1/dns_records?type=A&name=${RECORD}`,
					},
					response: { status: 200, body: { success: true, result: [] } },
				},
			],
		};
		expect(() =>
			pactBackedTransport(widened, {
				lifecycle: {
					...DNS_LIFECYCLE,
					answers: {
						...DNS_LIFECYCLE.answers,
						present: {
							[`GET /v4/zones/zone-1/dns_records?type=A&name=${RECORD}`]:
								"list all zone records",
						},
					},
				},
			}),
		).toThrow(/type is "CNAME" while the query asks for "A"/);
	});

	it("catches a request body the contract does not declare", async () => {
		const world = pactBackedTransport(dnsPact, { lifecycle: DNS_LIFECYCLE });
		await call(
			world,
			"POST",
			"https://api.cloudflare.com/v4/zones/zone-1/dns_records",
			{
				body: JSON.stringify({ type: "CNAME", name: RECORD, content: "wrong" }),
			},
		);
		const violations = world.fidelityViolations();
		expect(violations).toHaveLength(1);
		expect(violations[0]?.kind).toBe("body-mismatch");
		expect(violations[0]?.detail).toContain("content");
	});
});

describe("the contract covers the branch a second deploy takes", () => {
	it("declares the update the driver issues once the record exists", () => {
		// This interaction did not exist before this lane drove the real driver.
		// The consumer contract test only ever exercised the create branch,
		// because a stateless mock always answers "absent" — so the update path,
		// which runs on every deploy after the first, had never been checked
		// against the contract at all. The matrix found it as an
		// `unmatched-path` fidelity violation on the retry.
		const update = dnsPact.interactions.find(
			(i) =>
				i.request.method === "PUT" &&
				i.request.path === "/v4/zones/zone-1/dns_records/rec1",
		);
		expect(update).toBeDefined();
		// SAFETY: assertion required at this I/O or test boundary.
		expect((update?.response.body as { success?: boolean })?.success).toBe(
			true,
		);
	});

	it("records both the absent and the present state of the same collection", () => {
		// The pair that makes convergence provable from this document.
		const empty = dnsPact.interactions.find(
			(i) => i.description === "list dns records empty",
		);
		const populated = dnsPact.interactions.find(
			(i) => i.description === "list all zone records",
		);
		// SAFETY: assertion required at this I/O or test boundary.
		expect((empty?.response.body as { result?: unknown[] })?.result).toEqual(
			[],
		);
		expect(
			// SAFETY: assertion required at this I/O or test boundary.
			(populated?.response.body as { result?: { id: string }[] })?.result?.[0]
				?.id,
		).toBe("rec1");
	});

	it("still verifies against the stateless mock every other consumer uses", () => {
		// Adding an interaction must not change how the shared mock answers the
		// interactions that were already there.
		const stub = createMockProviderFromPact(dnsPact);
		expect(
			stub.handle({
				method: "GET",
				path: `/v4/zones/zone-1/dns_records?type=CNAME&name=${RECORD}`,
			}).status,
		).toBe(200);
	});
});

/**
 * The DNS contract records no request headers, so driving only that subject
 * would leave `header-mismatch` and `unmatched-path` as code that has never
 * been observed to fire — which is the same as not having them. The load
 * balancing contract does record `Accept`, `Authorization` and `Content-Type`,
 * so it is the subject that can exercise the header half.
 *
 * This block tests the *harness*, not a driver: it drives the world by hand so
 * each fidelity kind is produced deliberately. The driver-level proof is the
 * matrix above.
 */
describe("fidelity classification", () => {
	const LB_PUT =
		"https://api.cloudflare.com/client/v4/zones/zone-a/load_balancers/load-balancer-a";
	const LB_BODY = {
		name: "checkout.example.test",
		default_pools: ["pool-primary"],
		fallback_pool: "pool-primary",
		steering_policy: "random",
		enabled: true,
		random_steering: { pool_weights: { "pool-primary": 1 } },
	};
	const RECORDED_HEADERS = {
		Accept: "application/json",
		Authorization: "Bearer test-token",
		"Content-Type": "application/json",
	};

	async function put(
		world: ReturnType<typeof pactBackedTransport>,
		headers: Readonly<Record<string, string>>,
	) {
		return call(world, "PUT", LB_PUT, {
			headers,
			body: JSON.stringify(LB_BODY),
		});
	}

	it("accepts a request that carries every recorded header", async () => {
		const world = pactBackedTransport(lbPact);
		const response = await put(world, RECORDED_HEADERS);
		expect(response.status).toBe(200);
		expect(world.fidelityViolations()).toEqual([]);
	});

	it("reports a dropped credential header rather than answering as if nothing happened", async () => {
		// The failure this catches for real: a driver that assembles headers on
		// its happy path and takes a different branch while recovering. The
		// provider would answer 401; a mock that ignores headers answers 200 and
		// the lane stays green.
		const world = pactBackedTransport(lbPact);
		const { Authorization: _dropped, ...withoutAuth } = RECORDED_HEADERS;
		await put(world, withoutAuth);
		const violations = world.fidelityViolations();
		expect(violations).toHaveLength(1);
		expect(violations[0]?.kind).toBe("header-mismatch");
		expect(violations[0]?.detail).toContain("authorization");
	});

	it("matches headers case-insensitively, as HTTP does", async () => {
		const world = pactBackedTransport(lbPact);
		await put(world, {
			accept: "application/json",
			authorization: "Bearer test-token",
			"content-type": "application/json",
		});
		expect(world.fidelityViolations()).toEqual([]);
	});

	it("reports a path no interaction declares", async () => {
		const world = pactBackedTransport(lbPact);
		await call(
			world,
			"GET",
			"https://api.cloudflare.com/client/v4/zones/zone-a/nothing_recorded",
		);
		const violations = world.fidelityViolations();
		expect(violations).toHaveLength(1);
		expect(violations[0]?.kind).toBe("unmatched-path");
		expect(world.countUnmatched()).toBe(1);
	});

	it("sequences a PUT-idempotent lifecycle, not just the DNS shape", async () => {
		// Generality check: this contract creates with PUT on the same path it
		// reads and deletes, where the DNS one creates with POST on a collection.
		// A harness that only worked for one shape would be a harness for one test.
		const world = pactBackedTransport(lbPact, {
			lifecycle: {
				initial: "absent",
				created: "present",
				creates: ["PUT /client/v4/zones/zone-a/load_balancers/load-balancer-a"],
				answers: {},
				transitions: {
					"PUT /client/v4/zones/zone-a/load_balancers/load-balancer-a":
						"present",
					"DELETE /client/v4/zones/zone-a/load_balancers/load-balancer-a":
						"absent",
				},
			},
		});
		expect(world.state()).toBe("absent");
		await put(world, RECORDED_HEADERS);
		expect(world.state()).toBe("present");
		expect(world.countCreates()).toBe(1);
		await call(world, "DELETE", LB_PUT);
		expect(world.state()).toBe("absent");
		expect(world.fidelityViolations()).toEqual([]);
	});
});

/**
 * A second driver, on a different contract shape, because a matrix that only
 * ever ran against one subject is a matrix tuned to one subject.
 *
 * The DNS contract creates with POST against a collection and reads through a
 * filtered query. This one creates with **PUT against the same path it reads
 * and deletes** — the idempotent shape — and records request headers, which the
 * DNS contract does not. If the harness only worked for the first shape it
 * would be a harness for one test.
 *
 * The driver also differs in a way that matters for chaos: its internal
 * `request` swallows every transport error and returns `{ok: false}` rather
 * than throwing, so `apply` always resolves. Left alone, `converge()` would
 * never reject and every scenario would look like a success. The binding below
 * turns a non-`full` realization into a rejection, which is what makes a
 * degraded apply visible to the matrix at all.
 */
const ROUTING_PLAN = parseRoutingPlan({
	planId: "plan:checkout:pact",
	intent: {
		service: "checkout.example.test",
		tenantId: "tenant-a",
		rules: [
			{
				backends: [
					{
						id: "backend:primary",
						service: "checkout",
						weight: 100,
						endpoint: "https://checkout.example.test",
					},
				],
				weightStrategy: "static",
			},
		],
	},
	backends: [
		{
			id: "backend:primary",
			service: "checkout",
			weight: 100,
			endpoint: "https://checkout.example.test",
		},
	],
	createdAt: "2026-08-03T15:00:00.000Z",
});

const LB_SELECTOR = "/client/v4/zones/zone-a/load_balancers/load-balancer-a";

const LB_LIFECYCLE: PactLifecycle = {
	initial: "absent",
	created: "present",
	creates: [`PUT ${LB_SELECTOR}`],
	// The caller names the load balancer (`load-balancer-a`), so a repeated PUT
	// lands on the same resource. This is the shape where re-issuing the write
	// after a lost response is the correct recovery rather than a duplicate.
	identity: "client-supplied",
	answers: {},
	transitions: {
		[`PUT ${LB_SELECTOR}`]: "present",
		[`DELETE ${LB_SELECTOR}`]: "absent",
	},
};

function routingSubject(): PactChaosSubject {
	return {
		label: "cloudflare-lb/createCloudflareTrafficRouting",
		lifecycle: LB_LIFECYCLE,
		world: (lifecycle) => pactBackedTransport(lbPact, { lifecycle }),
		bind: ({ fetchImpl }) => {
			const routing = createCloudflareTrafficRouting({
				apiToken: "test-token",
				zoneId: "zone-a",
				loadBalancerIdsByPlan: {
					"plan:checkout:pact": "load-balancer-a",
				},
				poolIdsByBackend: { "backend:primary": "pool-primary" },
				fetchImpl,
			});
			return {
				converge: async () => {
					const result = await routing.apply(ROUTING_PLAN);
					if (result.realized !== "full") {
						throw new Error(
							`apply realized ${result.realized}: ${result.notes.join("; ")}`,
						);
					}
				},
				observe: async () => {
					const status = await routing.status(ROUTING_PLAN.planId);
					return status.active ? [status] : [];
				},
				remove: async () => {
					const result = await routing.revoke(ROUTING_PLAN.planId);
					if (!result.ok) {
						throw new Error(`revoke failed: ${result.notes.join("; ")}`);
					}
				},
			};
		},
	};
}

/**
 * Both subjects get the same two assertions, because both claims are about the
 * matrix rather than about one driver: it found nothing wrong, and it actually
 * ran. The second is not ceremony — "no violations" is also what a matrix that
 * silently ran zero scenarios reports.
 */
describe.each([
	// 6 faults x (2 call indices + 1 double + 2 teardown) = 30.
	{ name: "createCloudflareDnsProvider", make: () => subject(), scenarios: 30 },
	// One call in its lifecycle, so 6 x (1 + 1 + 2) = 24.
	{
		name: "createCloudflareTrafficRouting",
		make: () => routingSubject(),
		scenarios: 24,
	},
])("$name under the full failure matrix", ({ make, scenarios }) => {
	it("converges and stays faithful to the contract in every scenario", async () => {
		expect(pactChaosViolations(await runPactChaosMatrix(make()))).toEqual([]);
	});

	it("actually ran the matrix it claims to have run", async () => {
		const results = await runPactChaosMatrix(make());
		expect(results).toHaveLength(scenarios);
		expect(new Set(results.map((r) => r.fault)).size).toBe(6);
		expect(new Set(results.map((r) => r.kind))).toEqual(
			new Set(["single", "double", "teardown"]),
		);
		// At least one scenario must reach "the write landed, the client never
		// learned" — the case the lane exists for.
		expect(results.some((r) => r.writeLanded && !r.firstRejected)).toBe(true);
	});
});

describe("what only the DNS subject can show", () => {
	it("keeps chaos and the world in step on the create call", async () => {
		// Harness self-check, not a driver claim: call 1 is the create, and a
		// fault that corrupts only the response must leave the world created.
		// If these disagree, chaos stopped passing writes through and every
		// "write landed" scenario is testing nothing.
		const results = await runPactChaosMatrix(subject());
		for (const r of results.filter((x) => x.kind === "single" && x.at === 1)) {
			expect(r.writeLanded, `${r.fault} on the create`).toBe(
				WRITE_REACHING_FAULTS.includes(r.fault),
			);
		}
	});

	it("adopts rather than re-creating once the record exists", async () => {
		const world = pactBackedTransport(dnsPact, { lifecycle: DNS_LIFECYCLE });
		const run = subject().bind({
			transport: world.transport,
			fetchImpl: world.fetchImpl,
		});
		await run.converge();
		await run.converge();
		await run.converge();
		expect(world.countCreates()).toBe(1);
		expect(await run.observe()).toHaveLength(1);
	});
});

describe("the matrix can go red", () => {
	/**
	 * A negative control. Every assertion above is of the form "no violations",
	 * which a matrix that silently stopped checking would also satisfy. This
	 * subject is deliberately non-convergent — it POSTs without ever looking
	 * first — so the suite fails if the duplication rules stop firing.
	 *
	 * It is written against the *provider-minted* DNS lifecycle on purpose. That
	 * is the shape where blind-writing is genuinely wrong, and it is also the
	 * guard on `identity: "client-supplied"`: if that flag ever started
	 * suppressing the rules unconditionally rather than per-lifecycle, this goes
	 * green and the test fails.
	 */
	function blindWriter(): PactChaosSubject {
		return {
			label: "negative-control/blind-post",
			lifecycle: DNS_LIFECYCLE,
			world: (lifecycle) => pactBackedTransport(dnsPact, { lifecycle }),
			bind: ({ transport }) => {
				const base = {
					headers: {},
					timeoutMs: 5_000,
					maxResponseBytes: 65_536,
				};
				return {
					converge: async () => {
						await transport({
							method: "POST",
							url: "https://api.cloudflare.com/v4/zones/zone-1/dns_records",
							...base,
							body: JSON.stringify({
								type: "CNAME",
								name: RECORD,
								content: "funnel.ts.net",
							}),
						});
					},
					observe: async () => {
						const res = await transport({
							method: "GET",
							url: "https://api.cloudflare.com/v4/zones/zone-1/dns_records?per_page=100",
							...base,
						});
						// SAFETY: assertion required at this I/O or test boundary.
						const body = JSON.parse(res.body) as {
							result?: readonly unknown[];
						};
						return body.result ?? [];
					},
				};
			},
		};
	}

	it("reports the driver that never looks before it writes", async () => {
		const results = await runPactChaosMatrix(blindWriter());
		const violations = pactChaosViolations(results);
		expect(violations.length).toBeGreaterThan(0);
		expect(violations.join("\n")).toMatch(
			/read that showed the resource already present|read that failed/,
		);
	});

	it("keeps the duplication rules scoped to provider-minted identities", async () => {
		// The same blind writer, relabelled as client-supplied, must stop being
		// reported — otherwise the flag is not doing what it says. Paired with
		// the test above, this pins the gate in both directions.
		const relabelled: PactChaosSubject = {
			...blindWriter(),
			lifecycle: { ...DNS_LIFECYCLE, identity: "client-supplied" },
			world: (lifecycle) => pactBackedTransport(dnsPact, { lifecycle }),
		};
		const violations = pactChaosViolations(
			await runPactChaosMatrix(relabelled),
		);
		expect(
			violations.filter((v) => /another create|read that/.test(v)),
		).toEqual([]);
	});
});
