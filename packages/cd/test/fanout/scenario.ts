// A deterministic run that writes every fan-out event body at least once:
// Started, Progressed (each outcome), Halted, Resumed, Completed (COMPLETED
// and SUPERSEDED), RolledBack and camp.Departed. Used by the CUE agreement
// and golden-corpus tests.
import { FanoutStrategy } from "../../src/_generated/cd_pb.js";
import { decisionOf, fanoutOf, freightIdOf, healthy } from "./fakes.js";
import {
	addCamps,
	drive,
	freightB,
	harness,
	idOf,
	startInput,
} from "./harness.js";

const freightC = freightIdOf("sha256:cccc");

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
	await h.controller.resume(idOf(a.value), h.ctx);
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
		startInput(narrow, fanoutOf(), { freightId: freightC }),
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
	await h.controller.halt(idOf(d.value), "operator stop", h.ctx);
	await h.controller.rollback(idOf(d.value), "bad release", h.ctx);
	return h;
}
