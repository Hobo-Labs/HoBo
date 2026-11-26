import { describe, expect, it } from "vitest";

import {
	CAPABILITY_PROFILE_SCHEMA,
	CONVEX_CONFORMANCE_SUITE_REF,
	DATA_CONVEX_CAPABILITY_PROFILE,
	DATA_CONVEX_NON_REFINEMENTS,
	DATA_CONVEX_PROFILE_ID,
	explainNonRefinement,
	profileComposes,
	profileRefines,
} from "../src/capability-profile.js";
import { CONVEX_CONFORMANCE_PROFILE } from "../src/conformance.js";

const profile = DATA_CONVEX_CAPABILITY_PROFILE;

describe("data.convex/v1 capability profile", () => {
	it("is a frozen descriptor, not a registry", () => {
		expect(profile.schema).toBe(CAPABILITY_PROFILE_SCHEMA);
		expect(profile.id).toBe(DATA_CONVEX_PROFILE_ID);
		expect(profile.id).toBe("data.convex/v1");
		expect(profile.primitive).toBe("data");
		expect(Object.isFrozen(profile)).toBe(true);
		expect(["experimental", "preview", "stable"]).toContain(profile.maturity);
	});

	it("refines exactly data.document/v1", () => {
		expect(profile.refines).toEqual(["data.document/v1"]);
		expect(profileRefines(profile, "data.document/v1")).toBe(true);
	});

	it("is NOT data.postgres and NOT data.sqlite", () => {
		for (const notThis of [
			"data.postgres/v1",
			"data.sqlite/v1",
			"data.mysql/v1",
			"data.relational/v1",
			"data.kv/v1",
		]) {
			expect(profileRefines(profile, notThis)).toBe(false);
			expect(profile.composes).not.toContain(notThis);
			expect(explainNonRefinement(notThis)).toBeTypeOf("string");
		}
	});

	it("explains the storage-engine confusion instead of leaving it implicit", () => {
		expect(explainNonRefinement("data.postgres/v1")).toMatch(/POSTGRES_URL/u);
		expect(explainNonRefinement("data.sqlite/v1")).toMatch(/SQLite/u);
		expect(DATA_CONVEX_NON_REFINEMENTS.length).toBeGreaterThanOrEqual(5);
		for (const entry of DATA_CONVEX_NON_REFINEMENTS) {
			expect(entry.reason.length).toBeGreaterThan(20);
		}
	});

	it("composes the four surfaces a Convex deployment really exposes", () => {
		expect([...profile.composes].sort()).toEqual([
			"api.http/v1",
			"bucket.file-storage/v1",
			"realtime.websocket/v1",
			"service.scheduled/v1",
		]);
		expect(profileComposes(profile, "realtime.websocket/v1")).toBe(true);
		expect(profileComposes(profile, "data.document/v1")).toBe(false);
	});

	it("never refines or composes itself", () => {
		expect(profile.refines).not.toContain(profile.id);
		expect(profile.composes).not.toContain(profile.id);
	});

	it("points at a conformance suite that exists in this package", () => {
		expect(profile.conformanceSuiteRef).toBe(CONVEX_CONFORMANCE_SUITE_REF);
		expect(CONVEX_CONFORMANCE_PROFILE.id).toBe(profile.conformanceSuiteRef);
	});

	it("carries dated source references for every third-party fact", () => {
		expect(profile.sourceRefs.length).toBeGreaterThan(0);
		for (const ref of profile.sourceRefs) {
			expect(ref.url).toMatch(/^https:\/\//u);
			expect(ref.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
			expect(ref.note.length).toBeGreaterThan(10);
		}
	});
});
