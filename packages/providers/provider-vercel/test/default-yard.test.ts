import { describe, expect, it } from "vitest";

import {
	VERCEL_BLOB_PRODUCT_ID,
	VERCEL_DEFAULT_BINDINGS,
	VERCEL_DEFAULT_REGIONS,
	VERCEL_EDGE_CONFIG_PRODUCT_ID,
	VERCEL_EDGE_FUNCTION_PRODUCT_ID,
	VERCEL_STATIC_DEPLOY_PRODUCT_ID,
	VERCEL_UNRESOLVED_PRODUCT_IDS,
	VercelYardSpecError,
	vercelResolverRegistry,
	vercelSlotCatalog,
	vercelYardRows,
	vercelYardSpec,
} from "../src/index.js";

const registry = vercelResolverRegistry({
	resolveCredential: async () => "vercel-api-token-value",
});

describe("default vercel yard", () => {
	it("declares the provider and the documented default region", () => {
		const spec = vercelYardSpec();
		expect(spec.provider).toBe("vercel");
		expect(spec.regions).toEqual([...VERCEL_DEFAULT_REGIONS]);
	});

	it("emits flat rows keyed on the capability profile, canonically sorted", () => {
		expect(vercelYardSpec().bindings).toEqual([
			{
				profile: "bucket.object/v1",
				productId: VERCEL_BLOB_PRODUCT_ID,
				properties: {},
			},
			{
				profile: "kv.key-value/v1",
				productId: VERCEL_EDGE_CONFIG_PRODUCT_ID,
				properties: {},
			},
			{
				profile: "service.worker/v1",
				productId: VERCEL_EDGE_FUNCTION_PRODUCT_ID,
				properties: {},
			},
			{
				profile: "web.hosted/v1",
				productId: VERCEL_STATIC_DEPLOY_PRODUCT_ID,
				properties: {},
			},
		]);
	});

	it("carries no slot field on a row", () => {
		for (const row of vercelYardSpec().bindings) {
			expect(Object.keys(row).sort()).toEqual([
				"productId",
				"profile",
				"properties",
			]);
		}
	});

	it("keeps the slot catalog grouped, one array of offerings per slot", () => {
		expect(VERCEL_DEFAULT_BINDINGS.web?.map((row) => row.productId)).toEqual([
			VERCEL_STATIC_DEPLOY_PRODUCT_ID,
		]);
		expect(
			VERCEL_DEFAULT_BINDINGS.service?.map((row) => row.productId),
		).toEqual([VERCEL_EDGE_FUNCTION_PRODUCT_ID]);
		expect(VERCEL_DEFAULT_BINDINGS.bucket?.map((row) => row.productId)).toEqual(
			[VERCEL_BLOB_PRODUCT_ID],
		);
		expect(VERCEL_DEFAULT_BINDINGS.kv?.map((row) => row.productId)).toEqual([
			VERCEL_EDGE_CONFIG_PRODUCT_ID,
		]);
	});

	it("binds each offering to the profile its slot expects", () => {
		expect(
			Object.entries(VERCEL_DEFAULT_BINDINGS).flatMap(([slot, bindings]) =>
				(bindings ?? []).map((row) => [slot, row.slot, row.profile]),
			),
		).toEqual([
			["web", "web", "web.hosted/v1"],
			["service", "service", "service.worker/v1"],
			["bucket", "bucket", "bucket.object/v1"],
			["kv", "kv", "kv.key-value/v1"],
		]);
	});

	it("invents no provider settings by default", () => {
		for (const row of vercelYardRows(VERCEL_DEFAULT_BINDINGS)) {
			expect(row.properties).toEqual({});
		}
	});

	it("carries per-offering settings into the rows", () => {
		const rows = vercelYardSpec({
			staticDeployment: { projectId: "prj_owned" },
			blob: { access: "private" },
		}).bindings;
		expect(
			rows.find((row) => row.productId === VERCEL_STATIC_DEPLOY_PRODUCT_ID)
				?.properties,
		).toEqual({ projectId: "prj_owned" });
		expect(
			rows.find((row) => row.productId === VERCEL_BLOB_PRODUCT_ID)?.properties,
		).toEqual({ access: "private" });
	});

	it("de-duplicates and sorts declared regions", () => {
		expect(
			vercelYardSpec({ regions: ["sfo1", "iad1", "sfo1"] }).regions,
		).toEqual(["iad1", "sfo1"]);
	});

	it("is deterministic and frozen", () => {
		expect(vercelYardSpec()).toEqual(vercelYardSpec());
		const spec = vercelYardSpec();
		expect(Object.isFrozen(spec)).toBe(true);
		expect(Object.isFrozen(spec.bindings)).toBe(true);
		expect(Object.isFrozen(spec.regions)).toBe(true);
		expect(spec.bindings.every((row) => Object.isFrozen(row))).toBe(true);
	});

	it("orders rows independently of catalog insertion order", () => {
		expect(vercelYardRows(vercelSlotCatalog())).toEqual(
			vercelYardRows(
				Object.freeze({
					kv: VERCEL_DEFAULT_BINDINGS.kv ?? [],
					web: VERCEL_DEFAULT_BINDINGS.web ?? [],
					bucket: VERCEL_DEFAULT_BINDINGS.bucket ?? [],
					service: VERCEL_DEFAULT_BINDINGS.service ?? [],
				}),
			),
		);
	});

	it.each([
		[[], "VERCEL_YARD_REGIONS_EMPTY"],
		[["IAD1"], "VERCEL_YARD_REGION_INVALID"],
		[["iad 1"], "VERCEL_YARD_REGION_INVALID"],
	])("refuses region list %j rather than falling back", (regions, code) => {
		const call = () => vercelYardSpec({ regions });
		expect(call).toThrow(VercelYardSpecError);
		try {
			call();
			expect.unreachable("an unusable region list must be refused");
		} catch (error) {
			if (!(error instanceof VercelYardSpecError)) throw error;
			expect(error.code).toBe(code);
		}
	});

	it("either resolves every catalogued offering or declares it unresolved", () => {
		const unresolved = vercelYardSpec()
			.bindings.map((row) => row.productId ?? "")
			.filter((productId) => registry.get(productId) === undefined)
			.sort();
		expect(unresolved).toEqual([...VERCEL_UNRESOLVED_PRODUCT_IDS]);
	});

	it("declares nothing unresolved that actually has a resolver", () => {
		for (const productId of VERCEL_UNRESOLVED_PRODUCT_IDS) {
			expect(registry.get(productId)).toBeUndefined();
		}
	});
});
