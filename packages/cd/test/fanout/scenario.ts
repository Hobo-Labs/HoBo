// A deterministic run that writes every fan-out event body at least once:
// Started, Progressed (each outcome), Halted, Resumed, Completed (COMPLETED
// and SUPERSEDED), RolledBack and camp.Departed. Used by the CUE agreement
// and golden-corpus tests.
import { FanoutStrategy } from "../../src/_generated/cd_pb.js";
import type { FanoutId, FreightId } from "../../src/ports.js";
import { decisionOf, fanoutOf, healthy } from "./fakes.js";
import { addCamps, drive, freightB, harness, startInput } from "./harness.js";

export async function fanoutScenario() {
	const h = harness();
	const wide = decisionOf(12, 4, { decisionId: "wide" });
	addCamps(h, wide);
	h.inventory.setStatus("c005", healthy("c005", [], false));
	const a = await h.controller.start(
		startInput(wide, fanoutOf({ maxFailures: 1 })),
		h.ctx,
	);
	if (!a.ok) throw new Error("start A refused");
	await drive(h, (c) => (c === "c001" || c === "c002" ? "fail" : "pass"), {
		maxTicks: 4,
	});
	await h.controller.resume(a.value.fanoutId as FanoutId, h.ctx);
	await drive(h);

	h.desired.place("c011", [
		{ name: "web", port: "hobo:http-service" },
		{ name: "orders-db", port: "database" },
	]);
	const narrow = decisionOf(8, 4, { decisionId: "narrow" });
	const b = await h.controller.start(
		startInput(narrow, fanoutOf(), { freightId: freightB }),
		h.ctx,
	);
	if (!b.ok) throw new Error("start B refused");
	const c = await h.controller.start(
		startInput(narrow, fanoutOf(), { freightId: "sha256:cccc" as FreightId }),
		h.ctx,
	);
	if (!c.ok) throw new Error("start C refused");
	await drive(h);

	const canary = decisionOf(4, 2, { node: "canary", decisionId: "canary" });
	const d = await h.controller.start(
		startInput(canary, fanoutOf({ strategy: FanoutStrategy.ALL })),
		h.ctx,
	);
	if (!d.ok) throw new Error("start D refused");
	await h.controller.halt(d.value.fanoutId as FanoutId, "operator stop", h.ctx);
	await h.controller.rollback(
		d.value.fanoutId as FanoutId,
		"bad release",
		h.ctx,
	);
	return h;
}
