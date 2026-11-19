import { describe, expect, it } from "vitest";

import { ComponentHostError } from "../src/errors.js";
import {
	isInterfaceId,
	parseComponentDescriptor,
	parseLinkRequest,
	parseProviderDescriptor,
} from "../src/parse.js";

const KV = "wasi:keyvalue/store@0.2.0";
const BLOB = "wasi:blobstore/blobstore@0.2.0";

describe("a component descriptor", () => {
	it("keeps the id it was given", () => {
		expect(parseComponentDescriptor({ id: "api" }).id).toBe("api");
	});

	it("refuses an empty id", () => {
		expect(() => parseComponentDescriptor({ id: "" })).toThrow(
			ComponentHostError,
		);
	});

	it("refuses an id that is not a string", () => {
		expect(() => parseComponentDescriptor({ id: 1 } as never)).toThrow(
			/component_id_required/,
		);
	});

	it("refuses a missing id", () => {
		expect(() => parseComponentDescriptor({} as never)).toThrow(
			/component_id_required/,
		);
	});

	it("says which side was unnamed", () => {
		expect(() => parseComponentDescriptor({} as never)).toThrow(/component/);
		expect(() => parseProviderDescriptor({} as never)).toThrow(/provider/);
	});

	it("defaults imports to none", () => {
		expect(parseComponentDescriptor({ id: "api" }).imports).toStrictEqual([]);
	});

	it("parses each declared import", () => {
		expect(
			parseComponentDescriptor({ id: "api", imports: [KV] }).imports,
		).toStrictEqual([KV]);
	});

	it("refuses a malformed interface id", () => {
		expect(() =>
			parseComponentDescriptor({ id: "api", imports: ["not-an-interface"] }),
		).toThrow();
	});

	it("defaults exports to none", () => {
		expect(parseComponentDescriptor({ id: "api" }).exports).toStrictEqual({});
	});

	it("keeps the exports it was given", () => {
		const handler = () => null;
		expect(
			parseComponentDescriptor({
				id: "api",
				exports: { [KV]: { get: handler } },
			} as never).exports,
		).toMatchObject({ [KV]: { get: handler } });
	});

	it("omits leases entirely when none are declared", () => {
		expect(parseComponentDescriptor({ id: "api" })).not.toHaveProperty(
			"leases",
		);
	});

	it("carries declared leases", () => {
		expect(
			parseComponentDescriptor({ id: "api", leases: ["lease-a"] }).leases,
		).toStrictEqual(["lease-a"]);
	});

	it("copies the leases rather than aliasing the caller's array", () => {
		const leases = ["lease-a"];
		const parsed = parseComponentDescriptor({ id: "api", leases });
		leases.push("lease-b");
		expect(parsed.leases).toHaveLength(1);
	});

	it("carries an empty lease list when one is declared", () => {
		expect(parseComponentDescriptor({ id: "api", leases: [] })).toHaveProperty(
			"leases",
		);
	});

	it("is frozen", () => {
		expect(Object.isFrozen(parseComponentDescriptor({ id: "api" }))).toBe(true);
	});

	it("marks itself parsed", () => {
		expect(parseComponentDescriptor({ id: "api" }).parsed).toBe(true);
	});
});

describe("a provider descriptor", () => {
	it("keeps the id it was given", () => {
		expect(parseProviderDescriptor({ id: "kv" }).id).toBe("kv");
	});

	it("refuses an empty id", () => {
		expect(() => parseProviderDescriptor({ id: "" })).toThrow(
			/provider_id_required/,
		);
	});

	it("refuses an id that is not a string", () => {
		expect(() => parseProviderDescriptor({ id: 1 } as never)).toThrow(
			ComponentHostError,
		);
	});

	it("defaults exports to none", () => {
		expect(parseProviderDescriptor({ id: "kv" }).exports).toStrictEqual({});
	});

	it("is frozen and marked parsed", () => {
		const parsed = parseProviderDescriptor({ id: "kv" });
		expect([Object.isFrozen(parsed), parsed.parsed]).toStrictEqual([
			true,
			true,
		]);
	});
});

describe("a link request", () => {
	const request = (overrides: Record<string, unknown> = {}) => ({
		componentId: "api",
		importInterface: KV,
		providerId: "kv",
		exportInterface: KV,
		...overrides,
	});

	it("parses all four names", () => {
		expect(parseLinkRequest(request())).toMatchObject({
			componentId: "api",
			providerId: "kv",
			importInterface: KV,
			exportInterface: KV,
		});
	});

	it("refuses an empty component id", () => {
		expect(() => parseLinkRequest(request({ componentId: "" }))).toThrow(
			/component_id_required/,
		);
	});

	it("refuses an empty provider id", () => {
		expect(() => parseLinkRequest(request({ providerId: "" }))).toThrow(
			/provider_id_required/,
		);
	});

	it("refuses a malformed import interface", () => {
		expect(() =>
			parseLinkRequest(request({ importInterface: "not-an-interface" })),
		).toThrow();
	});

	it("refuses a malformed export interface", () => {
		expect(() =>
			parseLinkRequest(request({ exportInterface: "not-an-interface" })),
		).toThrow();
	});

	it("allows the two interfaces to differ", () => {
		expect(
			parseLinkRequest(request({ exportInterface: BLOB })).exportInterface,
		).toBe(BLOB);
	});

	it("is frozen and marked parsed", () => {
		const parsed = parseLinkRequest(request());
		expect([Object.isFrozen(parsed), parsed.parsed]).toStrictEqual([
			true,
			true,
		]);
	});
});

describe("isInterfaceId", () => {
	it("accepts a well-formed interface id", () => {
		expect(isInterfaceId(KV)).toBe(true);
	});

	it("refuses a malformed one without throwing", () => {
		expect(isInterfaceId("not-an-interface")).toBe(false);
	});

	it("refuses an empty string", () => {
		expect(isInterfaceId("")).toBe(false);
	});

	it("refuses an id with no version", () => {
		expect(isInterfaceId("wasi:keyvalue/store")).toBe(false);
	});
});
