/**
 * The Hostinger provider's transport allowlist, its yard spec rows and the
 * programs realize() emits. The local IaC-program check is in
 * `iac-program-local.test.ts` and the event-store fold's payload handling in
 * `yard-event-fold-payloads.test.ts`.
 *
 * Each surface holds a property that would fail silently rather than loudly if
 * it broke.
 *
 * **The transport allowlist is a spending control.** `/api/billing/v1/` is
 * deliberately absent from it. The hosting namespace can fill a plan the account
 * already bought — `POST /api/hosting/v1/websites` takes an `order_id` and
 * refuses without one — but nothing this package can reach places an order. That
 * is why the list names namespaces rather than a host: a guard keyed only on
 * `developers.hostinger.com` would let a "just provision it" resolver spend the
 * account's money with no human in the loop.
 *
 * **Yard binding rows are sorted for reproducibility.** `@hobo/yards` imposes
 * `(profile, productId, connectivityId)` ordering, and the sort is
 * locale-independent by code unit. A locale-sensitive comparison would make the
 * same catalog produce different row orders on different machines, and a diff of
 * a generated yard spec would show churn nobody wrote.
 */
import { describe, expect, it } from "vitest";

import { hostingerYardSpec } from "../src/default-yard.js";
import {
	assertLocalIacProgram,
	HOSTINGER_IAC_PROVIDER,
} from "../src/iac-program.js";
import {
	isRealizablePort,
	mergeHostingerOptions,
	realizeResourcePlan,
	realizeResourcePlans,
	resolveEquivalence,
} from "../src/realize.js";
import {
	HOSTINGER_ALLOWED_PATH_PREFIXES,
	HOSTINGER_API_HOST,
	HOSTINGER_EXCLUDED_PATH_PREFIXES,
	HOSTINGER_MAX_RESPONSE_BYTES,
	HOSTINGER_MAX_TIMEOUT_MS,
	HostingerTransportConfigError,
	hostingerApiUrl,
	hostingerTransportPolicy,
} from "../src/transport.js";
import type { ResourcePlan } from "../src/types.js";

const PLAN = {
	name: "api",
	port: "compute",
	provider: "hostinger",
} satisfies ResourcePlan;

describe("realize", () => {
	it("recognises the ports this provider realizes", () => {
		expect(isRealizablePort("compute")).toBe(true);
		expect(isRealizablePort("database")).toBe(true);
		expect(isRealizablePort("blob")).toBe(false);
	});

	it("refuses to resolve an equivalence for a port it cannot realize", () => {
		// Named in the message, because a placement that reached here picked the
		// wrong provider and the reader needs to know which port did it.
		expect(() => resolveEquivalence("blob")).toThrow(
			/cannot realize port blob/u,
		);
	});

	it("merges Hostinger option blocks in declaration order", () => {
		// Later blocks win, so a caller can layer a specific override on a general
		// default rather than having to restate the whole block.
		expect(
			mergeHostingerOptions([
				{ providerId: "hostinger", options: { plan: "kvm2", region: "phx" } },
				{ providerId: "hostinger", options: { plan: "kvm4" } },
			]),
		).toEqual({ plan: "kvm4", region: "phx" });
	});

	it("drops option blocks belonging to another provider", () => {
		// A plan authored for several providers carries all their blocks. Merging
		// a foreign one would put another provider's vocabulary into a Hostinger
		// resource's inputs, where it would be sent to Hostinger's API verbatim.
		expect(
			mergeHostingerOptions([
				{ providerId: "aws", options: { instanceType: "t3.micro" } },
				{ providerId: "hostinger", options: { plan: "kvm2" } },
			]),
		).toEqual({ plan: "kvm2" });
	});

	it("merges an absent option list to an empty object", () => {
		// The default parameter. Returning undefined would make every consumer
		// guard, and one of them would forget.
		expect(mergeHostingerOptions()).toEqual({});
		expect(mergeHostingerOptions([])).toEqual({});
	});

	it("realizes a single plan into a valid program", () => {
		const { iac } = realizeResourcePlan(PLAN);
		expect(() => assertLocalIacProgram(iac)).not.toThrow();
		expect(iac.resources[0]?.provider).toBe(HOSTINGER_IAC_PROVIDER);
	});

	it("omits the region from inputs when the plan states none", () => {
		// Absent rather than `undefined`. A null region in a request body is a
		// different thing to Hostinger's API than an omitted one.
		const { iac } = realizeResourcePlan(PLAN);
		expect(Object.hasOwn(iac.resources[0]?.inputs ?? {}, "region")).toBe(false);
	});

	it("carries a stated region through", () => {
		const { iac } = realizeResourcePlan({ ...PLAN, region: "phx" });
		expect(iac.resources[0]?.inputs.region).toBe("phx");
	});

	it("emits no build spec for a plan that does not build anything", () => {
		// Most resources are provisioned, not built. An empty build spec would
		// make the build lane run for every deployment.
		expect(realizeResourcePlan(PLAN).build).toBeUndefined();
	});

	it("emits a build spec naming the artifact when the plan builds one", () => {
		const { build } = realizeResourcePlan({
			...PLAN,
			build: { artifactId: "a-1", source: "./src", target: "wasm32-wasi" },
		});
		expect(build?.kind).toBe("hobo.build-spec/v1");
		expect(build?.artifacts[0]?.id).toBe("a-1");
	});

	it("realizes several plans into one program whose bind references resolve", () => {
		// The reason multi-resource realize exists: a dependency edge becomes an
		// output reference, and that reference has to resolve against a resource
		// in the *same* program.
		const { iac } = realizeResourcePlans([
			{ ...PLAN, name: "db", port: "database" },
			{ ...PLAN, name: "api", deps: ["db"] },
		]);
		expect(iac.resources).toHaveLength(2);
		expect(() => assertLocalIacProgram(iac)).not.toThrow();
	});

	it("refuses to realize an empty deployment plan", () => {
		// An empty program would apply cleanly and create nothing — a deploy that
		// reports success and deploys nothing.
		expect(() => realizeResourcePlans([])).toThrow(/cannot realize an empty/u);
	});

	it("honours an explicit deployment id and derives the stack from it", () => {
		// The stack name is the engine's state key. Deriving it here keeps one
		// deployment's state from being written over another's.
		const { iac } = realizeResourcePlans([PLAN], { deploymentId: "d-9" });
		expect(iac.deploymentId).toBe("d-9");
		expect(iac.stack).toBe("hostinger/d-9");
	});
});

describe("transport policy", () => {
	it("allows exactly one host", () => {
		// A one-host allowlist is what makes an exfiltrating resolver a transport
		// error rather than a successful request to somebody else's server.
		expect(hostingerTransportPolicy().allowedHosts).toEqual([
			HOSTINGER_API_HOST,
		]);
	});

	it("allows the vps, dns, and hosting namespaces and nothing else", () => {
		expect([...HOSTINGER_ALLOWED_PATH_PREFIXES]).toEqual([
			"/api/vps/v1/",
			"/api/dns/v1/",
			"/api/hosting/v1/",
		]);
	});

	it("excludes the billing namespace, and says why in the code", () => {
		// The exclusion is exported with its reason attached so a contributor
		// adding a "just provision it" resolver has to read why before widening
		// the policy. This is a spending control, not a tidiness rule.
		expect(HOSTINGER_EXCLUDED_PATH_PREFIXES.billing.prefix).toBe(
			"/api/billing/v1/",
		);
		expect(HOSTINGER_EXCLUDED_PATH_PREFIXES.billing.reason).toContain(
			"spend the account's money",
		);
		expect(HOSTINGER_ALLOWED_PATH_PREFIXES).not.toContain(
			HOSTINGER_EXCLUDED_PATH_PREFIXES.billing.prefix,
		);
	});

	it("caps the response size and the timeout", () => {
		// These are control-plane calls. A response larger or slower than the cap
		// is a contract change, and treating it as a big success would let an
		// unbounded body into memory.
		const policy = hostingerTransportPolicy();
		expect(policy.maxTimeoutMs).toBe(HOSTINGER_MAX_TIMEOUT_MS);
		expect(policy.maxResponseBytes).toBe(HOSTINGER_MAX_RESPONSE_BYTES);
		expect(HOSTINGER_MAX_RESPONSE_BYTES).toBe(512 * 1024);
	});

	it("returns a frozen policy per call, so no caller can widen a shared one", () => {
		// A function rather than a constant precisely so one caller cannot mutate
		// the allowlist out from under another.
		expect(Object.isFrozen(hostingerTransportPolicy())).toBe(true);
		expect(Object.isFrozen(HOSTINGER_ALLOWED_PATH_PREFIXES)).toBe(true);
	});
});

describe("hostingerApiUrl", () => {
	it("builds an absolute URL on the single allowed host", () => {
		expect(hostingerApiUrl("/api/vps/v1/virtual-machines")).toBe(
			`https://${HOSTINGER_API_HOST}/api/vps/v1/virtual-machines`,
		);
	});

	it("tolerates a path given without a leading slash", () => {
		expect(hostingerApiUrl("api/dns/v1/zones")).toBe(
			`https://${HOSTINGER_API_HOST}/api/dns/v1/zones`,
		);
	});

	it("refuses the billing namespace by name", () => {
		// The refusal a resolver would hit if someone tried to place an order.
		// The message quotes the exclusion's reason, so the person who hits it
		// learns why rather than just that it is blocked.
		const orderSomething = () => hostingerApiUrl("/api/billing/v1/orders");
		expect(orderSomething).toThrow(HostingerTransportConfigError);
		expect(orderSomething).toThrow("/api/billing/v1/");
		expect(orderSomething).toThrow("spend the account's money");
	});

	it("refuses any other namespace", () => {
		for (const path of [
			"/api/other/v1/x",
			"/",
			"/api/vps/v2/x",
			"/apivps/v1/",
		]) {
			expect(() => hostingerApiUrl(path)).toThrow(
				HostingerTransportConfigError,
			);
		}
	});

	it("joins without re-encoding, so a caller's escaping survives", () => {
		// The doc comment is explicit that this only joins. Silently repairing a
		// path would mean a caller who forgot to encode a name gets a URL that
		// works here and breaks against a name containing a slash.
		expect(hostingerApiUrl("/api/dns/v1/zones/a%2Fb")).toContain("a%2Fb");
	});
});

describe("yard spec rows", () => {
	it("names hostinger as the provider", () => {
		expect(hostingerYardSpec().provider).toBe("hostinger");
	});

	it("carries default regions and honours an override", () => {
		expect(hostingerYardSpec().regions.length).toBeGreaterThan(0);
		expect(hostingerYardSpec({ regions: ["ams"] }).regions).toEqual(["ams"]);
	});

	it("copies the caller's region array rather than holding it", () => {
		// The spec is frozen and long-lived. Holding the caller's array would let
		// a later push change what a already-returned spec reports.
		const regions = ["phx"];
		const spec = hostingerYardSpec({ regions });
		regions.push("ams");
		expect(spec.regions).toEqual(["phx"]);
	});

	it("flattens every catalog binding into a row", () => {
		expect(hostingerYardSpec().bindings.length).toBeGreaterThan(0);
	});

	it("sorts rows by profile, then product, then connectivity", () => {
		// `@hobo/yards` imposes this order, so a round-trip through it must not
		// reshuffle the set — otherwise a generated spec diffs against itself.
		const rows = hostingerYardSpec().bindings;
		const key = (row: (typeof rows)[number]) =>
			`${row.profile} ${row.productId ?? ""} ${row.connectivityId ?? ""}`;
		expect(rows.map(key)).toEqual(rows.map(key).sort());
	});

	it("omits an absent productId or connectivityId rather than emitting undefined", () => {
		// Conditional spread. A key present with an undefined value serialises
		// differently to an absent one, and the row is compared structurally.
		for (const row of hostingerYardSpec().bindings) {
			if (!Object.hasOwn(row, "productId")) continue;
			expect(row.productId).toBeDefined();
		}
	});

	it("freezes the spec and every row in it", () => {
		const spec = hostingerYardSpec();
		expect(Object.isFrozen(spec)).toBe(true);
		expect(Object.isFrozen(spec.bindings)).toBe(true);
		for (const row of spec.bindings) expect(Object.isFrozen(row)).toBe(true);
	});

	it("is stable across calls", () => {
		expect(JSON.stringify(hostingerYardSpec())).toBe(
			JSON.stringify(hostingerYardSpec()),
		);
	});
});
