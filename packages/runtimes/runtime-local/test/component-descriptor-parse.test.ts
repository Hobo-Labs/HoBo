/**
 * Parsing the descriptors a component host is wired from.
 *
 * These are the parse-don't-validate boundary in front of the component host:
 * a descriptor goes in as loosely-typed configuration and comes out branded,
 * frozen, and known-good. Everything downstream — the link table, the route
 * map, the lease register — then indexes on those values without re-checking
 * them, which is only safe because nothing unchecked gets past here.
 *
 * Two rules carry that:
 *
 * **An id must be a non-empty string.** An unnamed component occupies a map
 * slot nothing can address: the registration appears to succeed, and the
 * failure surfaces much later as "no route" against something that looks
 * registered. Refusing at parse time turns a confusing runtime symptom into a
 * configuration error at the point the configuration is read.
 *
 * **Each id says which side it belongs to.** `component_id_required` and
 * `provider_id_required` are different codes for the same shape of mistake,
 * because an operator with both halves in one file needs to be told which one
 * to look at.
 *
 * The optional collections default rather than being required: most components
 * import nothing, export nothing, or hold no leases, and demanding three empty
 * literals in every descriptor would be noise with one correct answer.
 *
 * Interface ids go through the shared `parseInterfaceId`, so a malformed one is
 * refused here rather than becoming a map key nothing will ever match.
 */
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
		// An unnamed component occupies a map slot nothing can address, and the
		// failure would otherwise surface much later as "no route" against
		// something that looks registered.
		expect(() => parseComponentDescriptor({ id: "" })).toThrow(
			ComponentHostError,
		);
	});

	it("refuses an id that is not a string", () => {
		// Ids are map keys. A number would stringify into one that no lookup
		// built from a manifest could reproduce.
		// SAFETY: the fixture supplies the wrong type deliberately.
		expect(() => parseComponentDescriptor({ id: 1 } as never)).toThrow(
			/component_id_required/,
		);
	});

	it("refuses a missing id", () => {
		// SAFETY: the fixture omits a required field deliberately.
		expect(() => parseComponentDescriptor({} as never)).toThrow(
			/component_id_required/,
		);
	});

	it("says which side was unnamed", () => {
		// One shared code for both halves would leave an operator checking the
		// wrong half of their configuration.
		// SAFETY: the fixture omits a required field deliberately.
		expect(() => parseComponentDescriptor({} as never)).toThrow(/component/);
		// SAFETY: the fixture omits a required field deliberately.
		expect(() => parseProviderDescriptor({} as never)).toThrow(/provider/);
	});

	it("defaults imports to none", () => {
		// Most components import nothing; requiring an empty array in every
		// descriptor would be noise with one correct answer.
		expect(parseComponentDescriptor({ id: "api" }).imports).toStrictEqual([]);
	});

	it("parses each declared import", () => {
		expect(
			parseComponentDescriptor({ id: "api", imports: [KV] }).imports,
		).toStrictEqual([KV]);
	});

	it("refuses a malformed interface id", () => {
		// Refused here rather than becoming a map key nothing will ever match —
		// which would present as a link that silently never routes.
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
				// SAFETY: the parser reads exactly the fields a descriptor names.
			} as never).exports,
		).toMatchObject({ [KV]: { get: handler } });
	});

	it("omits leases entirely when none are declared", () => {
		// Absent rather than empty: a host distinguishing "holds no leases"
		// from "declared none" reads the presence of the key, and an empty
		// array would answer the wrong question.
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
		// A shared array would let a later mutation of the manifest change what
		// an already-registered component claims to hold.
		const leases = ["lease-a"];
		const parsed = parseComponentDescriptor({ id: "api", leases });
		leases.push("lease-b");
		expect(parsed.leases).toHaveLength(1);
	});

	it("carries an empty lease list when one is declared", () => {
		// Explicitly empty is a statement; it is kept rather than normalised
		// away, so the two cases stay distinguishable.
		expect(parseComponentDescriptor({ id: "api", leases: [] })).toHaveProperty(
			"leases",
		);
	});

	it("is frozen", () => {
		// Everything downstream indexes on these values without re-checking
		// them; a caller that could rewrite the id after parsing would defeat
		// the boundary.
		expect(Object.isFrozen(parseComponentDescriptor({ id: "api" }))).toBe(true);
	});

	it("marks itself parsed", () => {
		// The brand is how the host tells a checked descriptor from a raw one,
		// so it can accept both without parsing twice.
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
		// SAFETY: the fixture supplies the wrong type deliberately.
		expect(() => parseProviderDescriptor({ id: 1 } as never)).toThrow(
			ComponentHostError,
		);
	});

	it("defaults exports to none", () => {
		// A provider registered before its handlers are wired is legitimate;
		// the link step is what refuses an export that is not there.
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
		// Both halves are parsed. A link is between interfaces, so a malformed
		// export is as fatal as a malformed import.
		expect(() =>
			parseLinkRequest(request({ exportInterface: "not-an-interface" })),
		).toThrow();
	});

	it("allows the two interfaces to differ", () => {
		// An adapter provider legitimately exports one interface while the
		// component imports another; the host checks compatibility separately.
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
		// The predicate form exists so a caller can branch on shape rather than
		// catching — a try/catch around every candidate would make a normal
		// check read like an error path.
		expect(isInterfaceId("not-an-interface")).toBe(false);
	});

	it("refuses an empty string", () => {
		expect(isInterfaceId("")).toBe(false);
	});

	it("refuses an id with no version", () => {
		// The version is what makes a link's compatibility check meaningful;
		// accepting an unversioned id would defer the failure to the wire.
		expect(isInterfaceId("wasi:keyvalue/store")).toBe(false);
	});
});
