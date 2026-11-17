import { describe, expect, it } from "vitest";
import {
	captureAlchemySourceFence,
	verifyAlchemySourceFence,
} from "../src/source-fence.js";

const claim = {
	resourceId: "web",
	resourceType: "Spec.Worker",
	bindleName: "app",
	applicationName: "web",
	sourceKind: "module",
	sourcePath: "/source/app.ts",
	sourceDigest: `sha256:${"a".repeat(64)}`,
	environmentDigest: `sha256:${"b".repeat(64)}`,
	proofRef: "host:proof",
};

describe("trusted source fences", () => {
	it("snapshots an authority and refuses later mutation or mismatched claims", () => {
		let allowed = true;
		const input = {
			sourceDigest: claim.sourceDigest,
			environmentDigest: claim.environmentDigest,
			proofRef: claim.proofRef,
			verify: () => allowed,
		};
		const fence = captureAlchemySourceFence(input);
		expect(fence).toBeDefined();
		if (fence === undefined) throw new Error("test fence missing");
		input.sourceDigest = `sha256:${"c".repeat(64)}`;
		input.verify = () => false;
		expect(verifyAlchemySourceFence(fence, claim)).toBe(true);
		expect(
			verifyAlchemySourceFence(fence, {
				...claim,
				sourceDigest: input.sourceDigest,
			}),
		).toBe(false);
		allowed = false;
		expect(verifyAlchemySourceFence(fence, claim)).toBe(false);
	});

	it("refuses accessor-swapped and malformed host proofs without invoking getters", () => {
		let invoked = false;
		const withGetter = {
			get sourceDigest() {
				invoked = true;
				return claim.sourceDigest;
			},
			environmentDigest: claim.environmentDigest,
			proofRef: claim.proofRef,
			verify: () => true,
		};
		expect(captureAlchemySourceFence(withGetter)).toBeUndefined();
		expect(invoked).toBe(false);
		expect(
			captureAlchemySourceFence({
				sourceDigest: "bad",
				environmentDigest: claim.environmentDigest,
				proofRef: claim.proofRef,
				verify: () => true,
			}),
		).toBeUndefined();
	});
});
