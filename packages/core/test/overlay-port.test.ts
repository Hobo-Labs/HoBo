import { describe, expect, expectTypeOf, it } from "vitest";
import {
	type OverlayIdentity,
	type OverlayJoinOptions,
	parseTenantId,
} from "../src/index.js";

describe("overlay port: fleet member binding (ADR-0182)", () => {
	const tenantId = parseTenantId("tenant-a");

	it("OverlayIdentity carries an optional fleet member id", () => {
		const fleetNode: OverlayIdentity = {
			nodeId: "node-1",
			hostname: "box-1",
			overlayIps: ["100.64.0.1"],
			tags: ["tag:hobo-fleet"],
			tenantId,
			memberId: `dev_${"0".repeat(32)}`,
		};
		const plainNode: OverlayIdentity = {
			nodeId: "node-2",
			hostname: "box-2",
			overlayIps: [],
			tags: [],
			tenantId,
		};
		expect(fleetNode.memberId).toMatch(/^dev_[0-9a-f]{32}$/);
		expect(plainNode.memberId).toBeUndefined();
		expectTypeOf<OverlayIdentity["memberId"]>().toEqualTypeOf<
			string | undefined
		>();
	});

	it("OverlayJoinOptions keeps authKey optional, for the authority-minted OverlayJoin credential only", () => {
		const join: OverlayJoinOptions = {
			tenantId,
			hostname: "box-1",
			tags: ["tag:hobo-fleet"],
		};
		expect(join.authKey).toBeUndefined();
		expectTypeOf<OverlayJoinOptions["authKey"]>().toEqualTypeOf<
			string | undefined
		>();
	});
});
