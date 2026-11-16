import type {
	HttpTransport,
	ResolveRequest,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import { ResolverError } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	VERCEL_EDGE_CONFIG_PRODUCT_ID,
	VERCEL_PROJECT_PRODUCT_ID,
	VERCEL_RESOLVED_PRODUCT_IDS,
	VERCEL_RESOLVER_TRANSPORT_POLICY,
	VERCEL_STATIC_DEPLOY_PRODUCT_ID,
	VERCEL_UNRESOLVED_PRODUCT_IDS,
	vercelResolverRegistry,
	vercelResolvers,
} from "../src/index.js";
import {
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";

const CREDENTIAL_REF = "hobo-token://vercel/deploy";

function options(
	overrides: {
		readonly resolveCredential?: (ref: string) => Promise<string>;
		readonly teamId?: string;
	} = {},
) {
	return {
		mutationJournal: {
			persistence: "durable-cas" as const,
			claim: async () => ({ status: "claimed" as const }),
			acknowledge: async () => {},
			uncertain: async () => {},
		},
		resolveCredential:
			overrides.resolveCredential ?? (async () => "vercel-api-token-value"),
		...(overrides.teamId !== undefined
			? { teamId: overrides.teamId }
			: undefined),
	};
}

function resolverFor(
	productId: string,
	overrides: Parameters<typeof options>[0] = {},
) {
	const resolver = vercelResolvers(options(overrides)).find(
		(candidate) => candidate.productId === productId,
	);
	if (resolver === undefined) {
		throw new Error(`no resolver registered for ${productId}`);
	}
	return resolver;
}

function projectRequest(
	overrides: Partial<ResolveRequest> = {},
): ResolveRequest {
	return {
		ref: {
			slot: "web",
			productId: VERCEL_PROJECT_PRODUCT_ID,
			logicalId: "storefront",
			...overrides.ref,
		},
		desired: { framework: "nextjs", ...overrides.desired },
		credentialRef: overrides.credentialRef ?? CREDENTIAL_REF,
		...(overrides.observed !== undefined
			? { observed: overrides.observed }
			: undefined),
	};
}

function edgeConfigRequest(
	overrides: Partial<ResolveRequest> = {},
): ResolveRequest {
	return {
		ref: {
			slot: "kv",
			productId: VERCEL_EDGE_CONFIG_PRODUCT_ID,
			logicalId: "flags",
			...overrides.ref,
		},
		desired: { ...overrides.desired },
		credentialRef: overrides.credentialRef ?? CREDENTIAL_REF,
		...(overrides.observed !== undefined
			? { observed: overrides.observed }
			: undefined),
	};
}

type Handler = (request: TransportRequest) => TransportResponse;

function json(status: number, body: JsonValue): TransportResponse {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

function notFound(): TransportResponse {
	return json(404, { error: { code: "not_found", message: "not found" } });
}

type RecordedTransport = {
	readonly transport: HttpTransport;
	readonly calls: TransportRequest[];
};

function recorded(handler: Handler): RecordedTransport {
	const calls: TransportRequest[] = [];
	return {
		calls,
		transport: async (request) => {
			calls.push(request);
			return handler(request);
		},
	};
}

/** Replies with the same canned response to every call. */
function always(response: TransportResponse): Handler {
	return () => response;
}

/** In-memory stand-in for `/v9/projects`. Never touches the network. */
function projectApi(seed: readonly JsonObject[] = []): Handler {
	const store = new Map<string, JsonObject>();
	for (const entry of seed) store.set(String(entry.id), { ...entry });
	let sequence = store.size;
	return (request) => {
		const url = new URL(request.url);
		const segments = url.pathname.split("/").filter((part) => part.length > 0);
		const key = segments[2];
		const body =
			request.body === undefined ? {} : parseJsonObject(request.body);
		if (request.method === "POST" && key === undefined) {
			sequence += 1;
			const created = {
				...body,
				accountId: "team_hobo",
				id: `prj_${sequence}`,
			};
			store.set(created.id, created);
			return json(200, created);
		}
		const target =
			key === undefined
				? undefined
				: [...store.values()].find((entry) => {
						const idOrName = decodeURIComponent(key);
						return entry.id === idOrName || entry.name === idOrName;
					});
		if (target === undefined) return notFound();
		if (request.method === "GET") return json(200, target);
		if (request.method === "PATCH") {
			const updated = { ...target, ...body, id: target.id };
			store.set(String(target.id), updated);
			return json(200, updated);
		}
		if (request.method === "DELETE") {
			store.delete(String(target.id));
			return { status: 204, headers: {}, body: "" };
		}
		return json(405, { error: { code: "bad_method", message: "unsupported" } });
	};
}

/** In-memory stand-in for the documented Global Config family. */
function edgeConfigApi(seed: readonly JsonObject[] = []): Handler {
	const store = new Map<string, JsonObject>();
	for (const entry of seed) store.set(String(entry.id), { ...entry });
	let sequence = store.size;
	return (request) => {
		const url = new URL(request.url);
		const segments = url.pathname.split("/").filter((part) => part.length > 0);
		const key = segments[2];
		const body =
			request.body === undefined ? {} : parseJsonObject(request.body);
		if (key === undefined) {
			if (request.method === "GET") return json(200, [...store.values()]);
			sequence += 1;
			const created = {
				...body,
				id: `ecfg_${sequence}`,
				ownerId: "team_hobo",
			};
			store.set(created.id, created);
			return json(201, created);
		}
		const target = store.get(decodeURIComponent(key));
		if (target === undefined) return notFound();
		if (request.method === "GET") return json(200, target);
		if (request.method === "PUT") {
			const updated = { ...target, ...body, id: target.id };
			store.set(String(target.id), updated);
			return json(200, updated);
		}
		if (request.method === "DELETE") {
			store.delete(String(target.id));
			return { status: 204, headers: {}, body: "" };
		}
		return json(405, { error: { code: "bad_method", message: "unsupported" } });
	};
}

async function codeOf(run: () => Promise<void>): Promise<string> {
	try {
		await run();
	} catch (error) {
		if (error instanceof ResolverError) return error.code;
		throw error;
	}
	return "NO_ERROR_THROWN";
}

async function messageOf(run: () => Promise<void>): Promise<string> {
	try {
		await run();
	} catch (error) {
		if (error instanceof Error) return error.message;
		throw error;
	}
	return "NO_ERROR_THROWN";
}

describe("vercel resolver registry", () => {
	it("registers exactly the products it can converge", () => {
		const registry = vercelResolverRegistry(options());
		expect(registry.list().map((entry) => entry.productId)).toEqual([
			VERCEL_EDGE_CONFIG_PRODUCT_ID,
			VERCEL_PROJECT_PRODUCT_ID,
			VERCEL_STATIC_DEPLOY_PRODUCT_ID,
		]);
		expect(registry.get(VERCEL_PROJECT_PRODUCT_ID)?.providerId).toBe("vercel");
		for (const productId of VERCEL_UNRESOLVED_PRODUCT_IDS) {
			expect(registry.get(productId)).toBeUndefined();
		}
	});

	it("declares the resolved half, and the declaration matches the registry", () => {
		// The other four provider packages publish both halves, and anything
		// reporting coverage across providers reads the pair uniformly. Vercel
		// exported only the unresolved half, so such a reader saw it as
		// zero-of-two instead of two-of-four. Asserting the declaration against
		// the registry is what keeps the new constant from becoming a second,
		// drifting answer to a question the registry already answers.
		const listed = vercelResolverRegistry(options())
			.list()
			.map((entry) => entry.productId)
			.sort();
		expect([...VERCEL_RESOLVED_PRODUCT_IDS].sort()).toEqual(listed);
		// Resolved and unresolved are disjoint and together cover the catalog.
		for (const productId of VERCEL_RESOLVED_PRODUCT_IDS) {
			expect(VERCEL_UNRESOLVED_PRODUCT_IDS).not.toContain(productId);
		}
	});

	it("refuses a request for another product", async () => {
		const { transport } = recorded(projectApi());
		expect(
			await codeOf(() =>
				resolverFor(VERCEL_PROJECT_PRODUCT_ID).reconcile(
					projectRequest({
						ref: {
							slot: "bucket",
							productId: "vercel.blob/v1",
							logicalId: "assets",
						},
					}),
					transport,
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});
});

describe("vercel.project/v1 resolver", () => {
	it("creates a project when none exists", async () => {
		const { transport, calls } = recorded(projectApi());
		const outcome = await resolverFor(VERCEL_PROJECT_PRODUCT_ID).reconcile(
			projectRequest(),
			transport,
		);
		expect(outcome.action).toBe("create");
		expect(outcome.physicalId).toBe("prj_1");
		expect(outcome.outputs.name).toBe("storefront");
		expect(outcome.contract).toBe("hobo.resource-resolver/v1");
		expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
		for (const call of calls) {
			expect(call.url.startsWith("https://api.vercel.com/")).toBe(true);
		}
	});

	it("creates exactly once when reconciled twice", async () => {
		const { transport, calls } = recorded(projectApi());
		const resolver = resolverFor(VERCEL_PROJECT_PRODUCT_ID);
		const first = await resolver.reconcile(projectRequest(), transport);
		const second = await resolver.reconcile(projectRequest(), transport);
		expect(second.physicalId).toBe(first.physicalId);
		expect(second.action).toBe("adopt");
		expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});

	it("reports noop when the request already names the resource", async () => {
		const { transport, calls } = recorded(
			projectApi([{ id: "prj_9", name: "storefront", framework: "nextjs" }]),
		);
		const outcome = await resolverFor(VERCEL_PROJECT_PRODUCT_ID).reconcile(
			projectRequest({
				ref: {
					slot: "web",
					productId: VERCEL_PROJECT_PRODUCT_ID,
					logicalId: "storefront",
					physicalId: "prj_9",
				},
			}),
			transport,
		);
		expect(outcome.action).toBe("noop");
		expect(outcome.physicalId).toBe("prj_9");
		expect(calls.map((call) => call.method)).toEqual(["GET"]);
	});

	it("applies mutable deltas to an existing project", async () => {
		const { transport, calls } = recorded(
			projectApi([{ id: "prj_9", name: "storefront", framework: "remix" }]),
		);
		const outcome = await resolverFor(VERCEL_PROJECT_PRODUCT_ID).reconcile(
			projectRequest({
				desired: { framework: "nextjs", buildCommand: "pnpm build" },
			}),
			transport,
		);
		expect(outcome.action).toBe("update");
		expect(outcome.physicalId).toBe("prj_9");
		expect(outcome.outputs.framework).toBe("nextjs");
		expect(calls.map((call) => call.method)).toEqual(["GET", "PATCH"]);
	});

	it("reads an existing project and reports absence as undefined", async () => {
		const present = recorded(projectApi([{ id: "prj_9", name: "storefront" }]));
		const resolver = resolverFor(VERCEL_PROJECT_PRODUCT_ID);
		const found = await resolver.read?.(projectRequest(), present.transport);
		expect(found?.physicalId).toBe("prj_9");
		const empty = recorded(projectApi());
		expect(
			await resolver.read?.(projectRequest(), empty.transport),
		).toBeUndefined();
	});

	it("deletes, and treats an already-absent project as deleted", async () => {
		const { transport, calls } = recorded(
			projectApi([{ id: "prj_9", name: "storefront" }]),
		);
		const resolver = resolverFor(VERCEL_PROJECT_PRODUCT_ID);
		await resolver.delete(projectRequest(), transport);
		await resolver.delete(projectRequest(), transport);
		expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE", "GET"]);
	});

	it("carries teamId onto every call when the token is team scoped", async () => {
		const { transport, calls } = recorded(projectApi());
		await resolverFor(VERCEL_PROJECT_PRODUCT_ID, {
			teamId: "team_hobo",
		}).reconcile(projectRequest(), transport);
		for (const call of calls) {
			expect(call.url).toContain("teamId=team_hobo");
		}
	});

	it("never sends the credential anywhere but the authorization header", async () => {
		const { transport, calls } = recorded(projectApi());
		await resolverFor(VERCEL_PROJECT_PRODUCT_ID).reconcile(
			projectRequest(),
			transport,
		);
		for (const call of calls) {
			expect(call.headers.authorization).toBe("Bearer vercel-api-token-value");
			expect(call.url).not.toContain("vercel-api-token-value");
			expect(call.body ?? "").not.toContain("vercel-api-token-value");
		}
	});
});

describe("vercel.edge-config/v1 resolver", () => {
	it("creates an edge config when the list has no matching slug", async () => {
		const { transport, calls } = recorded(edgeConfigApi());
		const outcome = await resolverFor(VERCEL_EDGE_CONFIG_PRODUCT_ID).reconcile(
			edgeConfigRequest(),
			transport,
		);
		expect(outcome.action).toBe("create");
		expect(outcome.physicalId).toBe("ecfg_1");
		expect(outcome.outputs.slug).toBe("flags");
		expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
	});

	it("creates exactly once when reconciled twice", async () => {
		const { transport, calls } = recorded(edgeConfigApi());
		const resolver = resolverFor(VERCEL_EDGE_CONFIG_PRODUCT_ID);
		const first = await resolver.reconcile(edgeConfigRequest(), transport);
		const second = await resolver.reconcile(edgeConfigRequest(), transport);
		expect(second.physicalId).toBe(first.physicalId);
		expect(second.action).toBe("adopt");
		expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});

	it("renames an edge config the request already names", async () => {
		const { transport, calls } = recorded(
			edgeConfigApi([{ id: "ecfg_9", slug: "old-flags" }]),
		);
		const outcome = await resolverFor(VERCEL_EDGE_CONFIG_PRODUCT_ID).reconcile(
			edgeConfigRequest({
				ref: {
					slot: "kv",
					productId: VERCEL_EDGE_CONFIG_PRODUCT_ID,
					logicalId: "flags",
					physicalId: "ecfg_9",
				},
			}),
			transport,
		);
		expect(outcome.action).toBe("update");
		expect(outcome.outputs.slug).toBe("flags");
		expect(calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
	});

	it("reads by id and by discovered slug", async () => {
		const { transport } = recorded(
			edgeConfigApi([{ id: "ecfg_9", slug: "flags" }]),
		);
		const resolver = resolverFor(VERCEL_EDGE_CONFIG_PRODUCT_ID);
		expect(
			(await resolver.read?.(edgeConfigRequest(), transport))?.physicalId,
		).toBe("ecfg_9");
		const empty = recorded(edgeConfigApi());
		expect(
			await resolver.read?.(edgeConfigRequest(), empty.transport),
		).toBeUndefined();
	});

	it("deletes by discovered id and succeeds when nothing is there", async () => {
		const { transport, calls } = recorded(
			edgeConfigApi([{ id: "ecfg_9", slug: "flags" }]),
		);
		const resolver = resolverFor(VERCEL_EDGE_CONFIG_PRODUCT_ID);
		await resolver.delete(edgeConfigRequest(), transport);
		await resolver.delete(edgeConfigRequest(), transport);
		expect(calls.map((call) => call.method)).toEqual([
			"GET",
			"GET",
			"DELETE",
			"GET",
		]);
	});

	it("treats a 404 on an explicitly named delete as success", async () => {
		const { transport } = recorded(always(notFound()));
		await expect(
			resolverFor(VERCEL_EDGE_CONFIG_PRODUCT_ID).delete(
				edgeConfigRequest({
					ref: {
						slot: "kv",
						productId: VERCEL_EDGE_CONFIG_PRODUCT_ID,
						logicalId: "flags",
						physicalId: "ecfg_gone",
					},
				}),
				transport,
			),
		).resolves.toBeUndefined();
	});
});

describe("vercel resolver failure modes", () => {
	it("maps a vercel error body to a redacted provider refusal", async () => {
		const { transport } = recorded(
			always(
				json(403, {
					error: {
						code: "forbidden",
						message: "token sk-live-ABCDEFGH1234 cannot create projects",
					},
				}),
			),
		);
		const run = () =>
			resolverFor(VERCEL_PROJECT_PRODUCT_ID).reconcile(
				projectRequest(),
				transport,
			);
		expect(await codeOf(run)).toBe("RESOLVER_PROVIDER_REJECTED");
		const message = await messageOf(run);
		expect(message).toContain("forbidden");
		expect(message).toContain("[redacted]");
		expect(message).not.toContain("sk-live-ABCDEFGH1234");
	});

	it("maps a non-JSON success body to an unparseable output", async () => {
		const { transport } = recorded((request) =>
			request.method === "GET"
				? notFound()
				: { status: 200, headers: {}, body: "<html>nope</html>" },
		);
		expect(
			await codeOf(() =>
				resolverFor(VERCEL_PROJECT_PRODUCT_ID).reconcile(
					projectRequest(),
					transport,
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("maps a success body missing a documented field to unparseable", async () => {
		const { transport } = recorded((request) =>
			request.method === "GET" ? notFound() : json(200, { name: "storefront" }),
		);
		expect(
			await codeOf(() =>
				resolverFor(VERCEL_PROJECT_PRODUCT_ID).reconcile(
					projectRequest(),
					transport,
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("maps a non-array list body to unparseable", async () => {
		const { transport } = recorded(always(json(200, { edgeConfigs: [] })));
		expect(
			await codeOf(() =>
				resolverFor(VERCEL_EDGE_CONFIG_PRODUCT_ID).reconcile(
					edgeConfigRequest(),
					transport,
				),
			),
		).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("refuses a credentialRef that is not a locator", async () => {
		const { transport } = recorded(projectApi());
		expect(
			await codeOf(() =>
				resolverFor(VERCEL_PROJECT_PRODUCT_ID).reconcile(
					projectRequest({ credentialRef: "vercel-token" }),
					transport,
				),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it("refuses a locator whose scheme is not a registered custody scheme", async () => {
		const { transport } = recorded(projectApi());
		expect(
			await codeOf(() =>
				resolverFor(VERCEL_PROJECT_PRODUCT_ID).reconcile(
					projectRequest({ credentialRef: "https://example.test/token" }),
					transport,
				),
			),
		).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
	});

	it("refuses when custody cannot answer for the locator", async () => {
		const { transport } = recorded(projectApi());
		const rejecting = {
			resolveCredential: async () => {
				throw new Error("no such secret");
			},
		};
		expect(
			await codeOf(() =>
				resolverFor(VERCEL_PROJECT_PRODUCT_ID, rejecting).reconcile(
					projectRequest(),
					transport,
				),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
		const message = await messageOf(() =>
			resolverFor(VERCEL_PROJECT_PRODUCT_ID, rejecting).reconcile(
				projectRequest(),
				transport,
			),
		);
		expect(message).toContain("deposit");
	});

	it("refuses when custody returns an empty value", async () => {
		const { transport } = recorded(projectApi());
		expect(
			await codeOf(() =>
				resolverFor(VERCEL_PROJECT_PRODUCT_ID, {
					resolveCredential: async () => "   ",
				}).reconcile(projectRequest(), transport),
			),
		).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses a desired setting of the wrong type rather than dropping it", async () => {
		const { transport } = recorded(projectApi());
		expect(
			await codeOf(() =>
				resolverFor(VERCEL_PROJECT_PRODUCT_ID).reconcile(
					projectRequest({ desired: { framework: 7 } }),
					transport,
				),
			),
		).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("keeps the transport guard pointed at the documented endpoints", () => {
		expect(VERCEL_RESOLVER_TRANSPORT_POLICY.allowedHosts).toEqual([
			"api.vercel.com",
		]);
		expect(VERCEL_RESOLVER_TRANSPORT_POLICY.allowedPathPrefixes).toEqual([
			"/v1/global-config",
			"/v9/projects",
		]);
	});
});
