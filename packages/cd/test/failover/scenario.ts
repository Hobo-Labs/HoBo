// A deterministic run that writes every failover body at least once:
// Proposed, Started, Progressed, Completed, Refused, and rebalance.Requested.
import { create } from "@bufbuild/protobuf";
import { TaintEffect, TaintRecordSchema } from "../../src/_generated/cd_pb.js";
import { healthy, MINUTE } from "../fanout/fakes.js";
import { run, setup, taint } from "./setup.js";

export async function failoverScenario() {
	// A completed failover (Proposed → Started → Progressed → Completed).
	const s = await setup();
	taint(s, "eu-000");
	s.h.time.advance(6 * MINUTE);
	await run(s, "pass", 6);
	// A refused one: data lives in the failing Camp.
	s.h.desired.place("eu-001", [{ name: "orders-db", port: "database" }]);
	taint(s, "eu-001");
	s.h.time.advance(6 * MINUTE);
	await run(s, "pass", 2);
	// A rebalance with one move.
	s.h.desired.sets.delete("eu-001");
	s.h.inventory.setStatus(
		"eu-spare",
		healthy("eu-spare", [
			create(TaintRecordSchema, { key: "drain", effect: TaintEffect.NO_PLACE }),
		]),
	);
	s.h.inventory.camps.delete("a-us-spare");
	const rebalance = await s.failover.rebalance(
		{ pipeline: "web", node: "prod", reason: "spread", idempotencyKey: "r1" },
		s.h.ctx,
	);
	if (!rebalance.ok)
		throw new Error(`rebalance refused: ${rebalance.reasons[0]?.code}`);
	await run(s, "pass", 6);
	return s;
}
