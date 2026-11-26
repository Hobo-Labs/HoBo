import assert from "node:assert/strict";
import { create, toJsonString } from "@bufbuild/protobuf";
import {
	LocalRunEventSchema,
	LocalRunStateSchema,
} from "../src/_generated/readiness_pb.js";
import { initialLocalState, transitionLocalRun } from "../src/local-state.js";

// Complete finite graph exploration, without a depth or iteration limit. The
// invariants below describe the external safety contract, not expected outputs
// for individual switch branches in the implementation.
export function proveLocalSafety() {
	const events = [
		...[
			"ready",
			"submitted",
			"cancelled",
			"timed_out",
			"fault",
			"shutdown",
			"shutdown_failed",
		].map((kind) => create(LocalRunEventSchema, { kind })),
		...["succeeded", "failed", "cancelled", "timed_out", "uncertain"].map(
			(status) => create(LocalRunEventSchema, { kind: "result", status }),
		),
		...["complete", "errored", "terminated"].map((status) =>
			create(LocalRunEventSchema, { kind: "terminal", status }),
		),
	];
	const key = (state: ReturnType<typeof initialLocalState>) =>
		toJsonString(LocalRunStateSchema, state);
	const first = initialLocalState();
	const pending = [first];
	const seen = new Set([key(first)]);
	let edges = 0;
	let successes = 0;
	for (let index = 0; index < pending.length; index++) {
		const state = pending[index];
		if (!state) throw new Error("missing proof state");
		if (state.phase === "finished") {
			assert.ok([0, 1, 2, 124, 130].includes(state.exitCode));
			if (state.exitCode === 0) {
				successes++;
				assert.equal(state.outcome, "succeeded");
				assert.equal(state.resultStatus, "succeeded");
				assert.equal(state.workflowStatus, "complete");
				assert.equal(state.shutdownConfirmed, true);
				assert.equal(state.stopReason, "");
			} else assert.notEqual(state.outcome, "succeeded");
			if (!state.shutdownConfirmed) assert.equal(state.outcome, "uncertain");
		}
		for (const event of events) {
			let next: ReturnType<typeof initialLocalState>;
			try {
				next = transitionLocalRun(state, event);
			} catch {
				continue;
			}
			edges++;
			if (state.phase === "finished")
				assert.equal(
					key(next),
					key(state),
					"terminal outcome must be immutable",
				);
			if (state.stopReason)
				assert.equal(
					next.stopReason,
					state.stopReason,
					"stopped admission cannot reopen",
				);
			if (state.phase === "new" && event.kind === "submitted")
				assert.fail("runtime identity must be verified before submission");
			if (
				state.resultStatus &&
				state.resultStatus !== "succeeded" &&
				next.phase === "finished"
			)
				assert.notEqual(
					next.exitCode,
					0,
					"observed unsuccessful result must never pass",
				);
			if (state.phase !== "finished" && event.kind === "shutdown_failed")
				assert.notEqual(
					next.outcome,
					"succeeded",
					"cleanup failure cannot pass",
				);
			const encoded = key(next);
			if (!seen.has(encoded)) {
				seen.add(encoded);
				pending.push(next);
			}
		}
	}
	assert.ok(successes > 0, "proof must include a reachable successful run");
	return { states: seen.size, edges, successes };
}

if (process.argv[1]?.endsWith("/scripts/proof.ts")) {
	const proof = proveLocalSafety();
	console.log(
		`PASS: complete local-controller graph: ${proof.states} states, ${proof.edges} edges, ${proof.successes} successful terminal states. No false success; shutdown required; cancellation/fault irreversible; terminal states immutable.`,
	);
}
