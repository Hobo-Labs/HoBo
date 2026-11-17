import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IacRoutePermit } from "../src/iac-route.js";
import { createSqliteIacRouteAuthority } from "../src/iac-route-sqlite.js";

const digest = `sha256:${"d".repeat(64)}`;
const actions = [
	"begin",
	"consume",
	"deny",
	"unknown",
	"selected",
	"replay",
] as const;
type Action = (typeof actions)[number];

/** Exhaustive finite traces against the actual journal, not a mock.
 * Assumptions: every effect consumes its permit first; denial means an
 * independently verified no-effect/fenced result with no live reservation;
 * all contenders for the logical request share the same transactional file.
 */
describe("bounded route authority state machine", () => {
	it("prevents a second live effect across every four-step trace", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-route-model-"));
		const path = join(dir, "journal.sqlite");
		const first = createSqliteIacRouteAuthority({
			path,
			verifyOperation: () => true,
		});
		const second = createSqliteIacRouteAuthority({
			path,
			verifyOperation: () => true,
		});
		try {
			let caseId = 0;
			for (const a of actions)
				for (const b of actions)
					for (const c of actions)
						for (const d of actions) {
							const trace: Action[] = [a, b, c, d];
							const identity = {
								tenantId: "tenant",
								requestId: `trace-${caseId++}`,
							};
							const operationId = `sha256:${createHash("sha256").update(identity.requestId).digest("hex")}`;
							const authorized = {
								...identity,
								operationId,
								authorization: "host-proof",
							};
							const claim = await first.claim(authorized);
							if (claim.status !== "claimed")
								throw new Error("fresh claim missing");
							const claimToken = claim.claimToken;
							let permit: IacRoutePermit | undefined;
							let phase: "running" | "finished" = "running";
							let consumed = false;
							let liveEffects = 0;
							for (const action of trace) {
								if (action === "begin") {
									if (phase === "running" && permit === undefined) {
										permit = await first.beginAttempt({
											...identity,
											claimToken,
											operationId,
											targetId: `target-${trace.indexOf(action)}`,
											inventoryHash: digest,
										});
										consumed = false;
									} else {
										expect(() =>
											first.beginAttempt({
												...identity,
												claimToken,
												operationId,
												targetId: "blocked",
												inventoryHash: digest,
											}),
										).toThrow();
									}
								} else if (action === "consume" && permit !== undefined) {
									const actual = await second.consumeAttempt(permit);
									const allowed = phase === "running" && !consumed;
									expect(actual, trace.join("/")).toBe(allowed);
									if (actual) {
										consumed = true;
										liveEffects++;
									}
								} else if (
									action === "deny" &&
									phase === "running" &&
									permit !== undefined
								) {
									// The trusted denial proof includes permanent fencing of this effect.
									liveEffects = 0;
									await first.denyAttempt({ ...identity, claimToken, permit });
									expect(await second.verifyAttempt(permit)).toBe(false);
									permit = undefined;
									consumed = false;
								} else if (action === "unknown" && phase === "running") {
									await first.finish({
										...identity,
										claimToken,
										outcome:
											permit === undefined
												? { status: "uncertain" }
												: { status: "uncertain", targetId: permit.targetId },
									});
									phase = "finished";
								} else if (
									action === "selected" &&
									phase === "running" &&
									permit !== undefined &&
									consumed
								) {
									await first.finish({
										...identity,
										claimToken,
										outcome: { status: "selected", targetId: permit.targetId },
									});
									phase = "finished";
								} else if (action === "replay") {
									expect((await second.claim(authorized)).status).toBe(
										"existing",
									);
								}
								expect(liveEffects, trace.join("/")).toBeLessThanOrEqual(1);
								if (phase === "finished" && permit !== undefined) {
									expect(await second.verifyAttempt(permit)).toBe(false);
									expect(await second.consumeAttempt(permit)).toBe(false);
								}
							}
						}
			expect(caseId).toBe(1296);
		} finally {
			first.close();
			second.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
