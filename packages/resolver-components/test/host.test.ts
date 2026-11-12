// WP8 acceptance: egress denial, credential isolation + secret scanner,
// deterministic limits, describe caching, and the ResourceResolver seam.
import { createResolverRegistry, type JsonObject } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	defineResolverGuest,
	ok,
	outcome,
	type ResolverGuestExports,
	type ResolverGuestImports,
	type WitResolveRequest,
} from "../src/guest/index.js";
import {
	componentResolvers,
	createDescribeCache,
	EgressDenialCode,
	InvocationOutcome,
	isComponentResolver,
	RESOLVER_COMPONENT_METRICS,
	ResolverComponentError,
	type ResolverComponentErrorCode,
} from "../src/index.js";
import { manifestJson } from "./fixtures.js";
import {
	Clock,
	CREDENTIAL_REF,
	hosted,
	ManualTimers,
	request,
	respond,
	SECRET,
	Upstream,
} from "./harness.js";

const PRODUCT = "acme/site";

function describeExport() {
	return async () => ({
		componentId: "acme-static",
		version: "1.2.3",
		classes: [
			{
				productId: PRODUCT,
				slot: "web",
				retainedFields: ["replicas"],
				observeFields: ["tls.version", "cacheTtl"],
				directives: ["forceDelete"],
			},
		],
	});
}

/** A guest whose reconcile runs `body`; other operations are inert. */
function guestWith(
	body: (
		host: ResolverGuestImports,
		request: WitResolveRequest,
	) => Promise<JsonObject>,
	read?: ResolverGuestExports["read"],
) {
	return defineResolverGuest((host) => ({
		describe: describeExport(),
		reconcile: async (req) =>
			ok(
				outcome(
					"create",
					"site-1",
					Object.fromEntries(
						Object.entries(await body(host, req)).map(([key, value]) => [
							key,
							String(value),
						]),
					),
				),
			),
		read: read ?? (async () => ok(null)),
		delete: async () => ok(null),
		instances: async () => ok([]),
	}));
}

async function refusalOf(
	run: Promise<unknown>,
): Promise<ResolverComponentError> {
	try {
		await run;
	} catch (error) {
		if (error instanceof ResolverComponentError) return error;
		throw error;
	}
	throw new Error("expected a refusal");
}

function only<T>(values: readonly T[]): T {
	const [first] = values;
	if (values.length !== 1 || first === undefined)
		throw new Error(`expected exactly one, got ${values.length}`);
	return first;
}

async function resolverFor(
	guest: ReturnType<typeof guestWith>,
	manifest: JsonObject = manifestJson(),
	options: Parameters<typeof hosted>[3] = {},
) {
	const setup = await hosted(manifest, guest, `src-${Math.random()}`, options);
	const resolver = only(componentResolvers({ components: [setup.component] }));
	if (!isComponentResolver(resolver))
		throw new Error("expected a component resolver");
	return { ...setup, resolver };
}

describe("egress: a component that calls a non-allowlisted host is denied", () => {
	it("denies the call, never reaches the host, and fails the reconcile closed even if the guest swallows the error", async () => {
		const upstream = new Upstream().route("* https://evil.example", () =>
			respond(200, "pwned"),
		);
		const guest = guestWith(async (host) => {
			const result = await host.send({
				method: "GET",
				url: "https://evil.example/collect",
				headers: [],
				body: null,
			});
			return { swallowed: "err" in result ? "yes" : "no" };
		});
		const { resolver, invocations, metrics } = await resolverFor(guest);
		const error = await refusalOf(
			resolver.reconcile(request(PRODUCT, {}), upstream.transport),
		);
		expect(error.componentCode).toBe<ResolverComponentErrorCode>(
			"component.egress-denied",
		);
		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(error.remediation).toMatch(/allowlist/u);
		expect(upstream.requests).toHaveLength(0);
		const record = invocations.at(-1);
		expect(record?.outcome).toBe(InvocationOutcome.EGRESS_DENIED);
		expect(record?.denials[0]?.code).toBe(
			EgressDenialCode.HOST_NOT_ALLOWLISTED,
		);
		expect(
			metrics.points.some(
				(point) => point.name === RESOLVER_COMPONENT_METRICS.denials,
			),
		).toBe(true);
	});

	it("denies a redirect from an allowlisted host", async () => {
		const upstream = new Upstream().route("GET https://api.acme.test/v1/", () =>
			respond(302, "", { location: "https://evil.example/" }),
		);
		const guest = guestWith(async (host) => {
			await host.send({
				method: "GET",
				url: "https://api.acme.test/v1/site",
				headers: [],
				body: null,
			});
			return {};
		});
		const { resolver, invocations } = await resolverFor(guest);
		const error = await refusalOf(
			resolver.reconcile(request(PRODUCT, {}), upstream.transport),
		);
		expect(error.componentCode).toBe("component.egress-denied");
		expect(invocations.at(-1)?.denials[0]?.code).toBe(
			EgressDenialCode.REDIRECT,
		);
	});

	it("strips host-owned headers a component tries to set", async () => {
		const upstream = new Upstream().route("GET https://api.acme.test/v1/", () =>
			respond(200, "{}"),
		);
		const guest = guestWith(async (host) => {
			await host.send({
				method: "GET",
				url: "https://api.acme.test/v1/site",
				headers: [
					["Authorization", "Bearer guessed"],
					["x-trace", "1"],
				],
				body: null,
			});
			return {};
		});
		const { resolver } = await resolverFor(guest);
		await resolver.reconcile(request(PRODUCT, {}), upstream.transport);
		expect(upstream.requests[0]?.headers).toEqual({ "x-trace": "1" });
	});
});

describe("credentials: a component cannot read the credential value", () => {
	it("attaches the credential host-side, only to the bound host", async () => {
		const upstream = new Upstream().route("GET https://api.acme.test/v1/", () =>
			respond(200, "{}"),
		);
		const guest = guestWith(async (host, req) => {
			const result = await host.authorizedFetch(
				{
					method: "GET",
					url: "https://api.acme.test/v1/site",
					headers: [],
					body: null,
				},
				req.credentialRef,
			);
			return { status: "ok" in result ? result.ok.status : 0 };
		});
		const { resolver, credentials } = await resolverFor(guest);
		const outcome = await resolver.reconcile(
			request(PRODUCT, {}),
			upstream.transport,
		);
		expect(outcome.outputs).toEqual({ status: "200" });
		expect(upstream.requests[0]?.headers.authorization).toBe(
			`Bearer ${SECRET}`,
		);
		expect(credentials.calls).toEqual([
			{
				ref: CREDENTIAL_REF,
				scope: "resolver-component:acme-static:api.acme.test",
			},
		]);
	});

	it("exfiltration through the response body is caught by the secret scanner", async () => {
		// The upstream echoes the request headers; the component copies the body
		// into its outputs to smuggle the credential out.
		const upstream = new Upstream().route(
			"GET https://api.acme.test/v1/echo",
			(req) =>
				respond(200, JSON.stringify(req.headers), {
					"x-echo": req.headers.authorization ?? "",
				}),
		);
		const seen: string[] = [];
		const guest = guestWith(async (host, req) => {
			const result = await host.authorizedFetch(
				{
					method: "GET",
					url: "https://api.acme.test/v1/echo",
					headers: [],
					body: null,
				},
				req.credentialRef,
			);
			const body = "ok" in result ? result.ok.body : "";
			seen.push(
				body,
				...("ok" in result ? result.ok.headers.map(([, value]) => value) : []),
			);
			return { stolen: body };
		});
		const { resolver, invocations } = await resolverFor(guest);
		const error = await refusalOf(
			resolver.reconcile(request(PRODUCT, {}), upstream.transport),
		);
		expect(error.componentCode).toBe("component.secret-exfiltration");
		expect(error.message).not.toContain(SECRET);
		expect(seen.join("\n")).not.toContain(SECRET);
		expect(seen.join("\n")).toContain("[REDACTED]");
		const record = invocations.at(-1);
		expect(record?.outcome).toBe(InvocationOutcome.SECRET_EXFILTRATION);
		expect(record?.denials.map((denial) => denial.code)).toContain(
			EgressDenialCode.SECRET_EXFILTRATION,
		);
	});

	it("a leaked value returned in any encoding is withheld by the scanner", async () => {
		const upstream = new Upstream().route("GET https://api.acme.test/v1/", () =>
			respond(200, "{}"),
		);
		const guest = guestWith(async (host, req) => {
			await host.authorizedFetch(
				{
					method: "GET",
					url: "https://api.acme.test/v1/site",
					headers: [],
					body: null,
				},
				req.credentialRef,
			);
			// Simulates a guest that obtained the value out of band.
			return { blob: Buffer.from(`prefix:${SECRET}`).toString("base64") };
		});
		const { resolver } = await resolverFor(guest);
		const error = await refusalOf(
			resolver.reconcile(request(PRODUCT, {}), upstream.transport),
		);
		expect(error.componentCode).toBe("component.secret-exfiltration");
	});

	it("refuses a credential for an unbound host or a foreign locator", async () => {
		const upstream = new Upstream().route("* https://upload.acme.test/", () =>
			respond(200),
		);
		const guest = guestWith(async (host, req) => {
			await host.authorizedFetch(
				{
					method: "PUT",
					url: "https://upload.acme.test/x",
					headers: [],
					body: "a",
				},
				req.credentialRef,
			);
			await host.authorizedFetch(
				{
					method: "GET",
					url: "https://api.acme.test/v1/x",
					headers: [],
					body: null,
				},
				"vault://someone-else/token",
			);
			return {};
		});
		const { resolver, invocations, credentials } = await resolverFor(guest);
		const error = await refusalOf(
			resolver.reconcile(request(PRODUCT, {}), upstream.transport),
		);
		expect(error.componentCode).toBe("component.egress-denied");
		expect(invocations.at(-1)?.denials.map((denial) => denial.code)).toEqual([
			EgressDenialCode.CREDENTIAL_SCOPE,
			EgressDenialCode.CREDENTIAL_SCOPE,
		]);
		expect(credentials.calls).toHaveLength(0);
		expect(upstream.requests).toHaveLength(0);
	});

	it("log lines carrying material are refused", async () => {
		const upstream = new Upstream().route(
			"GET https://api.acme.test/v1/echo",
			(req) => respond(200, req.headers.authorization ?? ""),
		);
		const guest = guestWith(async (host, req) => {
			await host.authorizedFetch(
				{
					method: "GET",
					url: "https://api.acme.test/v1/site",
					headers: [],
					body: null,
				},
				req.credentialRef,
			);
			await host.log("info", `token is ${SECRET.split("").reverse().join("")}`);
			return {};
		});
		const { resolver, logs } = await resolverFor(guest);
		const error = await refusalOf(
			resolver.reconcile(request(PRODUCT, {}), upstream.transport),
		);
		expect(error.componentCode).toBe("component.secret-exfiltration");
		expect(logs).toHaveLength(0);
	});
});

describe("limits trip deterministically", () => {
	const looping = guestWith(async (host) => {
		for (let index = 0; index < 1_000; index += 1)
			await host.send({
				method: "GET",
				url: "https://api.acme.test/v1/ping",
				headers: [],
				body: null,
			});
		return {};
	});

	it("fuel: trips at the same import call on every run", async () => {
		const manifest = manifestJson({ limits: { fuel: "30000000" } });
		const counts: number[] = [];
		for (let run = 0; run < 2; run += 1) {
			const upstream = new Upstream().route(
				"GET https://api.acme.test/v1/",
				() => respond(200, "pong"),
			);
			const { resolver, invocations } = await resolverFor(looping, manifest);
			const error = await refusalOf(
				resolver.reconcile(request(PRODUCT, {}), upstream.transport),
			);
			expect(error.componentCode).toBe("component.fuel-exhausted");
			expect(invocations.at(-1)?.outcome).toBe(
				InvocationOutcome.FUEL_EXHAUSTED,
			);
			counts.push(upstream.requests.length);
		}
		expect(counts[0]).toBeGreaterThan(0);
		expect(counts[0]).toBe(counts[1]);
	});

	it("memory: a response larger than the budget trips at the same byte", async () => {
		const manifest = manifestJson({ limits: { memoryBytes: "4096" } });
		const upstream = new Upstream().route("GET https://api.acme.test/v1/", () =>
			respond(200, "x".repeat(5_000)),
		);
		const { resolver, invocations } = await resolverFor(looping, manifest);
		const error = await refusalOf(
			resolver.reconcile(request(PRODUCT, {}), upstream.transport),
		);
		expect(error.componentCode).toBe("component.memory-exceeded");
		expect(invocations.at(-1)?.outcome).toBe(InvocationOutcome.MEMORY_EXCEEDED);
	});

	it("time: a slow upstream trips the deadline at the next boundary", async () => {
		const clock = new Clock();
		const manifest = manifestJson({ limits: { callTimeoutMs: 5_000 } });
		const upstream = new Upstream().route(
			"GET https://api.acme.test/v1/",
			() => {
				clock.advance(3_000);
				return respond(200, "pong");
			},
		);
		const { resolver } = await resolverFor(looping, manifest, {
			now: clock.now,
		});
		const error = await refusalOf(
			resolver.reconcile(request(PRODUCT, {}), upstream.transport),
		);
		expect(error.componentCode).toBe("component.timeout");
		expect(upstream.requests).toHaveLength(2);
	});

	it("time: a guest that never yields is cut off by the backstop timer, and the next call gets a fresh instance", async () => {
		const timers = new ManualTimers();
		let hang = true;
		const guest = guestWith(async () => {
			if (hang) await new Promise<never>(() => undefined);
			return { fresh: "yes" };
		});
		const { resolver } = await resolverFor(guest, manifestJson(), { timers });
		const pending = resolver.reconcile(
			request(PRODUCT, {}),
			new Upstream().transport,
		);
		await new Promise((resolve) => setImmediate(resolve));
		expect(timers.pending).toHaveLength(1);
		timers.fireAll();
		expect((await refusalOf(pending)).componentCode).toBe("component.timeout");
		hang = false;
		const next = await resolver.reconcile(
			request(PRODUCT, {}),
			new Upstream().transport,
		);
		expect(next.outputs).toEqual({ fresh: "yes" });
	});
});

describe("describe() is cached by content digest and checked against the signed manifest", () => {
	it("calls describe once per digest across loads", async () => {
		let calls = 0;
		const guest = defineResolverGuest(() => ({
			describe: async () => {
				calls += 1;
				return describeExport()();
			},
			reconcile: async () => ok(outcome("noop", "x", {})),
			read: async () => ok(null),
			delete: async () => ok(null),
			instances: async () => ok([]),
		}));
		const cache = createDescribeCache();
		await hosted(manifestJson(), guest, "same-source", {
			describeCache: cache,
		});
		await hosted(manifestJson(), guest, "same-source", {
			describeCache: cache,
		});
		expect(calls).toBe(1);
	});

	it("refuses a component whose describe() disagrees with its manifest", async () => {
		const guest = defineResolverGuest(() => ({
			describe: async () => ({ ...(await describeExport()()), classes: [] }),
			reconcile: async () => ok(outcome("noop", "x", {})),
			read: async () => ok(null),
			delete: async () => ok(null),
			instances: async () => ok([]),
		}));
		const error = await refusalOf(
			hosted(manifestJson(), guest, "src-describe"),
		);
		expect(error.componentCode).toBe("component.describe-mismatch");
	});
});

describe("the ResourceResolver seam", () => {
	const guest = guestWith(
		async () => ({}),
		async () =>
			ok({
				outcome: outcome("noop", "site-1", {
					replicas: 7,
					region: "eu",
					cacheTtl: 60,
				}),
				attributes: [
					["cacheTtl", "60"],
					["tls.version", "1.3"],
					["internalOnly", "x"],
					["apiToken", "never"],
				],
			}),
	);

	it("registers through createResolverRegistry with provider, product and directives", async () => {
		const { resolver } = await resolverFor(guest);
		const registry = createResolverRegistry([resolver]);
		expect(registry.get(PRODUCT)?.providerId).toBe("acme");
		expect(registry.get(PRODUCT)?.directives).toEqual(["forceDelete"]);
		expect(resolver.component.signedBy).toBe(
			"spiffe://hobo/component-publisher",
		);
	});

	it("refuses a request routed to the wrong product", async () => {
		const { resolver } = await resolverFor(guest);
		const error = await refusalOf(
			resolver.reconcile(
				request("other/product", {}),
				new Upstream().transport,
			),
		);
		expect(error.componentCode).toBe("component.guest-unsupported");
	});

	it("a component's retained field is never reported as drift", async () => {
		const { resolver } = await resolverFor(guest);
		const retainedOnly = await resolver.observe(
			request(PRODUCT, { replicas: 2, region: "eu" }),
			new Upstream().transport,
			["cacheTtl", "tls.version", "internalOnly"],
		);
		expect(retainedOnly?.driftKind).toBe("");
		expect(retainedOnly?.retained).toEqual(["replicas"]);
		const real = await resolver.observe(
			request(PRODUCT, { replicas: 2, region: "us" }),
			new Upstream().transport,
			["cacheTtl"],
		);
		expect(real?.driftKind).toBe("modified:region");
	});

	it("read attributes are trimmed to the declared observe_fields", async () => {
		const { resolver } = await resolverFor(guest);
		const observed = await resolver.observe(
			request(PRODUCT, {}),
			new Upstream().transport,
			["cacheTtl", "internalOnly", "apiToken"],
		);
		expect(observed?.attributes).toEqual({ cacheTtl: "60" });
		expect(observed?.kind).toBe(PRODUCT);
		expect(observed?.physicalId).toBe("site-1");
	});

	it("emits invocation metrics through the TelemetrySink", async () => {
		const { resolver, metrics } = await resolverFor(guest);
		await resolver.read?.(request(PRODUCT, {}), new Upstream().transport);
		const names = new Set(metrics.points.map((point) => point.name));
		expect(names.has(RESOLVER_COMPONENT_METRICS.invocations)).toBe(true);
		expect(names.has(RESOLVER_COMPONENT_METRICS.fuel)).toBe(true);
	});
});
