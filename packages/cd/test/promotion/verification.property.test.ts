import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	PromotionState,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import { pipelineNode, resolvedFor } from "./doubles.js";
import { harness } from "./harness.js";
import { camp, fid } from "./store.js";

describe("CD promotion verification generated properties", () => {
	it("never requests qualification for a non-passing verification", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(
					fc.constantFrom(
						VerificationVerdict.PASS,
						VerificationVerdict.FAIL,
						VerificationVerdict.INCONCLUSIVE,
					),
					{ minLength: 1, maxLength: 4 },
				),
				async (verdicts) => {
					const h = harness();
					const ids = verdicts.map((_, index) => `staging-${index + 1}`);
					h.pipelines.define("shop", [
						pipelineNode("staging", { campIds: ids }),
					]);
					h.freight.add("f0");
					h.freight.add("f1");
					h.pipelines.makeAvailable("shop", "staging", "f1");
					for (const [index, id] of ids.entries()) {
						h.desired.seed(id, "f0", resolvedFor(id, "alpha", "f0"));
						const verdict = verdicts[index];
						if (verdict === undefined)
							throw new Error("fixture verdict missing");
						h.verification.verdictByCamp.set(id, verdict);
					}
					const qualify = h.freight.qualify.bind(h.freight);
					const requested: VerificationVerdict[] = [];
					h.freight.qualify = async (input) => {
						requested.push(input.result.verdict);
						return qualify(input);
					};
					const result = await h.service.promote(
						{
							freightId: fid("f1"),
							targets: ids.map(camp),
							idempotencyKey: "generated-verification",
							pipeline: "shop",
							node: "staging",
						},
						h.ctx(),
					);
					expect(
						requested.every((verdict) => verdict === VerificationVerdict.PASS),
					).toBe(true);
					if (
						verdicts.every((verdict) => verdict === VerificationVerdict.PASS)
					) {
						expect(result.ok && result.value.state).toBe(
							PromotionState.PROMOTED,
						);
						expect(requested).toHaveLength(ids.length);
					} else {
						expect(result.ok && result.value.state).toBe(PromotionState.FAILED);
						for (const id of ids)
							expect((await h.desired.current(camp(id)))?.freightId).toBe("f0");
					}
				},
			),
			{ seed: 614443, numRuns: 100 },
		);
	});
});
