// HoBo posture health source (D24, D25): reads the `noncompliant_ratio` and
// `shadow_divergence_count` series from the compliance and shadow projections
// through the frozen PostureSeriesReader. An INFORM node verifies on these.
//
// query:        "noncompliant_ratio" | "shadow_divergence_count"
// endpoint_ref: "" or the candidate Rail digest "sha256:<hex>"
//               (required for shadow_divergence_count)
//
// Posture is per Camp: CANARY and ALL read the Camp; there is no baseline.
// A window without compliance records yields no samples, so the engine fails
// it (I5) — never "compliant by absence".
import { create } from "@bufbuild/protobuf";
import {
	Aggregation,
	Cohort,
	Comparator,
	HealthQueryRecordSchema,
	HealthSourceKind,
	type VerificationSpecRecord,
	VerificationSpecRecordSchema,
} from "../../_generated/cd_pb.js";
import { CD_DEFAULTS } from "../../events.js";
import type { Digest, HealthSource, PostureSeriesReader } from "../../ports.js";
import { refuse } from "../reasons.js";
import { RATIO_UNIT } from "../spec.js";
import { samplesOutcome } from "./http.js";

export const POSTURE_SERIES = Object.freeze({
	noncompliantRatio: "noncompliant_ratio",
	shadowDivergenceCount: "shadow_divergence_count",
} as const);

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function railDigest(value: string): Digest | undefined {
	// SAFETY: matched against the Digest pattern.
	return DIGEST.test(value) ? (value as Digest) : undefined;
}

export function createHoboPostureSource(posture: PostureSeriesReader): HealthSource {
	return {
		kind: HealthSourceKind.HOBO_POSTURE,
		async query(input) {
			const { query } = input;
			if (input.cohort === Cohort.BASELINE) {
				return refuse("health-source-query-invalid", `${query.name}: posture has no baseline cohort; use a threshold`, query.name);
			}
			const digest = query.endpointRef === "" ? undefined : railDigest(query.endpointRef);
			if (query.endpointRef !== "" && !digest) {
				return refuse("health-source-endpoint-invalid", `${query.name}: endpoint_ref must be empty or a sha256 Rail digest`, query.name);
			}
			const window = { campId: input.campId, fromMs: input.fromMs, toMs: input.toMs };
			let values: readonly number[];
			if (query.query === POSTURE_SERIES.noncompliantRatio) {
				values = await posture.noncompliantRatio(digest ? { ...window, railDigest: digest } : window);
			} else if (query.query === POSTURE_SERIES.shadowDivergenceCount) {
				if (!digest) return refuse("health-source-query-invalid", `${query.name}: shadow_divergence_count needs the candidate Rail digest`, query.name);
				values = await posture.shadowDivergence({ ...window, railDigest: digest });
			} else {
				return refuse("health-source-query-invalid", `${query.name}: posture series must be noncompliant_ratio or shadow_divergence_count`, query.name);
			}
			return samplesOutcome(
				values.filter((value) => !Number.isNaN(value)),
				input.fromMs,
				input.toMs,
			);
		},
	};
}

/**
 * The default INFORM-node verification (Part I §I.8 R12): pass only with a
 * noncompliant ratio ≤ 2% and zero shadow divergences over 24 h. A Rail that
 * intends to block something widens `maxShadowDivergence` explicitly.
 */
export function informVerificationSpec(
	input: Readonly<{ railDigest: Digest; maxNoncompliantRatio?: number; maxShadowDivergence?: number }>,
): VerificationSpecRecord {
	const query = (name: string, series: string, unit: string) =>
		create(HealthQueryRecordSchema, { name, source: HealthSourceKind.HOBO_POSTURE, query: series, endpointRef: input.railDigest, unit });
	return create(VerificationSpecRecordSchema, {
		windowMs: BigInt(CD_DEFAULTS.informWindowMs),
		requiredObservations: 1,
		progressDeadlineMs: BigInt(CD_DEFAULTS.informWindowMs + CD_DEFAULTS.verificationProgressDeadlineMs),
		failOnNoData: true,
		thresholds: [
			{
				query: query("posture-noncompliant-ratio", POSTURE_SERIES.noncompliantRatio, RATIO_UNIT),
				aggregation: Aggregation.MAX,
				comparator: Comparator.LTE,
				value: input.maxNoncompliantRatio ?? CD_DEFAULTS.informMaxNoncompliantRatio,
			},
			{
				query: query("posture-shadow-divergence", POSTURE_SERIES.shadowDivergenceCount, "count"),
				aggregation: Aggregation.SUM,
				comparator: Comparator.LTE,
				value: input.maxShadowDivergence ?? CD_DEFAULTS.informMaxShadowDivergence,
			},
		],
	});
}
