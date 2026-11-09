import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	canonicalPlanJson,
	type DeploymentPlan,
	hashDeploymentPlan,
	type JsonValue,
	type PlanParseInput,
	type PlanParseObject,
	parseDeploymentPlan,
} from "../src/index.js";

const objectTag = Object.prototype.toString;

/**
 * Round trip over the fixtures that already exist in the repo.
 *
 * These are `@hobo/cloud`'s own committed plans, read from their real location
 * rather than copied: a copy is how a schema comes to pass its own test while
 * failing on live data, and if someone moves or edits the originals this suite
 * should notice.
 */
function fixture(name: string): JsonValue {
	const parsed: JsonValue = JSON.parse(
		readFileSync(
			fileURLToPath(
				new URL(`../../cloud/test/fixtures/${name}.json`, import.meta.url),
			),
			"utf8",
		),
	);
	return parsed;
}

function asPlanObject(value: JsonValue, name: string): PlanParseObject {
	if (
		value === null ||
		Array.isArray(value) ||
		objectTag.call(value) !== "[object Object]"
	) {
		throw new Error(`fixture ${name} is not an object`);
	}
	return value;
}

function resourceList(raw: PlanParseObject, name: string): PlanParseInput[] {
	const resources = raw.resources;
	if (!Array.isArray(resources)) {
		throw new Error(`fixture ${name} has no resources array`);
	}
	return [...resources];
}

interface PlanFixture {
	[key: string]: PlanParseInput | undefined;
}

function asResourceObject(value: PlanParseInput, name: string): PlanFixture {
	if (
		value === null ||
		Array.isArray(value) ||
		objectTag.call(value) !== "[object Object]"
	) {
		throw new Error(`${name} resource is not an object`);
	}
	const out: PlanFixture = {};
	for (const key of Object.keys(value)) {
		out[key] = value[key];
	}
	return out;
}

interface MutableJsonObject {
	[key: string]: JsonValue;
}

/** The same canonicalization, written independently of the module under test. */
function independentCanonicalJson(value: JsonValue): string {
	const sort = (v: JsonValue): JsonValue => {
		if (Array.isArray(v)) return v.map(sort);
		if (v !== null && objectTag.call(v) === "[object Object]") {
			const out: MutableJsonObject = {};
			for (const key of Object.keys(v).sort()) {
				const entry = v[key];
				if (entry === undefined) continue;
				out[key] = sort(entry);
			}
			return out;
		}
		return v;
	};
	return JSON.stringify(sort(value));
}

function overlayResources(
	raw: PlanParseObject,
	resources: PlanParseInput[],
): PlanFixture {
	const out: PlanFixture = {};
	for (const key of Object.keys(raw)) {
		out[key] = raw[key];
	}
	out.resources = resources;
	return out;
}

// Pinned in packages/cloud/test/planner.test.ts, gateway.test.ts and
// placement.test.ts as HELLO_BINDLE_PLAN_HASH. Reproducing it here is the whole
// point of the round trip: the digest is compared across packages, so a
// schema that loses a field, materializes an absent optional, or reorders an
// array is caught by this one constant rather than by review.
const GOLDEN_PLAN_HASH =
	"sha256:0e1bbf78ae6b765d8a4cd5cb41c5b9c5eadc43e32ea4fedec97cf87a7deef915";
const SHOP_PLAN_HASH =
	"sha256:6012432813829d6ffc013426b9792365f85ad2260c14c3f22276625a597f3421";

describe("round trip over @hobo/cloud's committed plan fixtures", () => {
	it.each([
		["golden-plan", GOLDEN_PLAN_HASH],
		["multi-cloud-shop-plan", SHOP_PLAN_HASH],
	])("%s survives parse -> canonical form byte-identically", (name, digest) => {
		const raw = fixture(name);
		const parsed = parseDeploymentPlan(raw);

		// Byte-identical: the parsed value canonicalizes to exactly the bytes the
		// raw fixture canonicalizes to. Not `toEqual` — a lost field, an added
		// default, or a reordered array all survive a structural comparison of
		// the wrong two things, and none of them survive this.
		expect(canonicalPlanJson(parsed)).toBe(independentCanonicalJson(raw));
		expect(hashDeploymentPlan(parsed)).toBe(digest);
	});

	it("golden-plan's absent optionals stay absent rather than becoming defaults", () => {
		const parsed = parseDeploymentPlan(fixture("golden-plan"));
		const assets = parsed.resources.find((r) => r.name === "assets");
		expect(assets).toBeDefined();
		if (assets === undefined) {
			throw new Error("expected assets resource");
		}
		// `in`, not `=== undefined`: under exactOptionalPropertyTypes the whole
		// distinction this schema defends is absent-vs-present-holding-undefined,
		// and only the key test can tell them apart.
		expect(Object.hasOwn(assets, "deploymentId")).toBe(false);
		expect(Object.hasOwn(assets, "productId")).toBe(false);
		expect(Object.hasOwn(assets, "realizationParameters")).toBe(false);
		expect(Object.hasOwn(assets, "nonPortableRows")).toBe(false);
		// ...while the ones the fixture does carry are present and exact.
		expect(assets.strategy).toBe("rolling-update");
		expect(assets.region).toBe("ENAM");
	});

	it("materializing one absent optional as an empty string changes the digest", () => {
		// This is what hobo.cloud.v1's wire form does today: `string region = 6;`
		// is a bare proto3 singular, which has no field presence, so a decoder
		// cannot tell an absent region from "". The measurement is why this
		// package's .proto spells every optional scalar `optional`.
		const raw = asPlanObject(
			fixture("multi-cloud-shop-plan"),
			"multi-cloud-shop-plan",
		);
		const flattened = overlayResources(
			raw,
			resourceList(raw, "multi-cloud-shop-plan").map((r) => {
				const node = asResourceObject(r, "multi-cloud-shop-plan");
				node.strategy = "";
				node.region = "";
				node.deploymentId = "";
				return node;
			}),
		);
		const round = hashDeploymentPlan(parseDeploymentPlan(flattened));
		expect(round).not.toBe(SHOP_PLAN_HASH);
		expect(round).toBe(
			"sha256:f6a09e775c201c927668009b57d278e859899c6f9eceac894d1a775a72f03029",
		);
	});

	it("a Yard-bound node's non-string realization parameters survive byte-identically", () => {
		// The value is the one packages/cloud/test/plan-binding-authority.test.ts
		// asserts the planner produces: `{ ttlSeconds: 3600, tier: "standard" }`.
		// `ttlSeconds` is a number, and hobo.cloud.v1's `map<string, string>`
		// cannot carry it — see the README.
		const raw = asPlanObject(fixture("golden-plan"), "golden-plan");
		const bound = overlayResources(
			raw,
			resourceList(raw, "golden-plan").map((r) => {
				const node = asResourceObject(r, "golden-plan");
				if (node.name === "sessions") {
					node.productId = "cloudflare.kv/v1";
					node.realizationParameters = {
						ttlSeconds: 3600,
						tier: "standard",
					};
					node.nonPortableRows = ["kv/cloudflare.kv/v1"];
				}
				return node;
			}),
		);
		const parsed = parseDeploymentPlan(bound);
		expect(canonicalPlanJson(parsed)).toBe(independentCanonicalJson(bound));

		const sessions = parsed.resources.find((r) => r.name === "sessions");
		expect(sessions?.realizationParameters).toEqual({
			ttlSeconds: 3600,
			tier: "standard",
		});
		// The number stayed a number. Encoding it as canonical JSON text — the
		// convention hobo.cloud.v1's proto comment names — would make it
		// indistinguishable from the string "3600".
		expect(objectTag.call(sessions?.realizationParameters?.ttlSeconds)).toBe(
			"[object Number]",
		);
	});

	it("re-parsing a parsed plan is a fixed point", () => {
		const once = parseDeploymentPlan(fixture("golden-plan"));
		const twiceJson: JsonValue = JSON.parse(canonicalPlanJson(once));
		const twice = parseDeploymentPlan(twiceJson);
		expect(canonicalPlanJson(twice)).toBe(canonicalPlanJson(once));
		expect(hashDeploymentPlan(twice)).toBe(GOLDEN_PLAN_HASH);
	});

	it("array order is part of the digest: resources are a list, not a set", () => {
		const raw = asPlanObject(fixture("golden-plan"), "golden-plan");
		const reversed = overlayResources(
			raw,
			[...resourceList(raw, "golden-plan")].reverse(),
		);
		expect(hashDeploymentPlan(parseDeploymentPlan(reversed))).not.toBe(
			GOLDEN_PLAN_HASH,
		);
	});

	it("the shop plan is typed as a DeploymentPlan without a cast", () => {
		const plan: DeploymentPlan = parseDeploymentPlan(
			fixture("multi-cloud-shop-plan"),
		);
		expect(plan.schema).toBe("hobo.deployment-plan/v1");
		expect(plan.resources.map((r) => r.name)).toEqual([
			"network",
			"database",
			"cache",
			"api",
			"web",
		]);
	});
});
