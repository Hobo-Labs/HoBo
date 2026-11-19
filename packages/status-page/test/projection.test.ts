
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

interface EventSpec {
	readonly type?: string;
	readonly seq: number;
	readonly ts: string;
	readonly project?: string;
	readonly data?: JsonObject;
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
		rows: (specs: readonly EventSpec[]) => fold(specs).rows,
		defaultScopeKey: (spec: EventSpec) => defaultScopeKey(toEnvelope(spec)),
		statusFromAttainment,
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
		readSet: () => [...createStatusPageProjection().readSet].sort(),
		isDeterministic: (specs: readonly EventSpec[]) => {
			const first = JSON.stringify(fold(specs));
			const second = JSON.stringify(fold(specs));
			return first === second;
		},
	}),
});
