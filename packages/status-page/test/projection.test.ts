/**
 * Every case is a line in `projection.cases.jsonl`.
 *
 * A projection is a fold over events, and an event is JSON, so the cases are
 * the events themselves. Event types are written as literals rather than
 * through `STATUS_*_EVENTS`: a rename then fails every case that uses it rather
 * than only the read-set assertion.
 */

import { describeConcern } from "@hobo/contract-harness";
import type { EventEnvelope, JsonObject } from "@hobo/core";
import {
	createStatusPageProjection,
	defaultScopeKey,
	HISTORY_DAY_LIMIT,
	statusEnvelope,
	statusFromAttainment,
} from "../src/index.js";

const STREAM = "status:test";

/** One event, either spelled out or via the `slo` shorthand. */
interface EventSpec {
	readonly type?: string;
	readonly seq: number;
	readonly ts: string;
	readonly project?: string;
	/** The payload, verbatim — including deliberately malformed ones. */
	readonly data?: JsonObject;
	/** An `slo.Measured` with the standard payload, overridden field by field. */
	readonly slo?: JsonObject;
}

function toEnvelope(spec: EventSpec): EventEnvelope {
	const data = spec.slo
		? {
				componentId: "kit-web",
				sloName: "availability",
				attainment: 0.9995,
				target: 0.999,
				measuredAt: spec.ts,
				...spec.slo,
			}
		: (spec.data ?? {});
	const options = {
		streamId: STREAM,
		seq: spec.seq,
		ts: spec.ts,
	};
	if (spec.project !== undefined) options.project = spec.project;
	return statusEnvelope(spec.type ?? "slo.Measured", data, options);
}

const fold = (specs: readonly EventSpec[]) =>
	createStatusPageProjection().fold(specs.map(toEnvelope));

describeConcern("status page projection", {
	cases: `${import.meta.dirname}/projection.cases.jsonl`,
	subject: () => ({
		/** The folded rows, keyed by scope — what every snapshot case asserts on. */
		rows: (specs: readonly EventSpec[]) => fold(specs).rows,
		defaultScopeKey: (spec: EventSpec) => defaultScopeKey(toEnvelope(spec)),
		statusFromAttainment,
		/**
		 * Bounded history, which needs more events than are worth writing down.
		 *
		 * Emits one clean sample per day past the limit, then a second, bad
		 * sample on the final day so the day has to roll up to the worst of the
		 * two rather than the last of them.
		 */
		historySummary: () => {
			const specs: EventSpec[] = [];
			for (let day = 0; day < HISTORY_DAY_LIMIT + 10; day += 1) {
				const ts = new Date(Date.UTC(2026, 0, 1 + day)).toISOString();
				specs.push({ seq: day + 1, ts, project: "shop", slo: {} });
			}
			const lastTs = new Date(
				Date.UTC(2026, 0, HISTORY_DAY_LIMIT + 10),
			).toISOString();
			specs.push({
				seq: specs.length + 1,
				ts: lastTs,
				project: "shop",
				slo: { attainment: 0.5 },
			});
			const history =
				fold(specs).rows["project:shop"]?.components["kit-web"]?.history ?? {};
			const dates = Object.keys(history).sort();
			const last = history[dates.at(-1) ?? ""];
			return {
				withinLimit: dates.length <= HISTORY_DAY_LIMIT,
				worst: last?.worst ?? null,
				samples: last?.samples ?? null,
			};
		},
		/** The read-set is a contract with the data plane, so it is pinned exactly. */
		readSet: () => [...createStatusPageProjection().readSet].sort(),
		isDeterministic: (specs: readonly EventSpec[]) => {
			// Two independent folds over the same events, each from a fresh
			// projection — replay must not depend on anything but the stream.
			const first = JSON.stringify(fold(specs));
			const second = JSON.stringify(fold(specs));
			return first === second;
		},
	}),
});
