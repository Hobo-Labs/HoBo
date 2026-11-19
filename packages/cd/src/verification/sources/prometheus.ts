import { createHash } from "node:crypto";
import { HealthSourceKind } from "../../_generated/cd_pb.js";
import type { HealthSource } from "../../ports.js";
import { isJsonArray, isJsonNumber, isJsonObject } from "../json.js";
import {
	byKey,
	cohortSelector,
	credentialFor,
	httpsEndpoint,
	invalid,
	requestJson,
	type SourceDeps,
	sampleValue,
	stableKey,
} from "./http.js";

export const PROMETHEUS_MAX_POINTS = 60;
export const PROMETHEUS_MIN_STEP_SECONDS = 15;

export function prometheusStepSeconds(fromMs: number, toMs: number): number {
	const windowSeconds = Math.max(1, Math.floor((toMs - fromMs) / 1000));
	return Math.max(
		PROMETHEUS_MIN_STEP_SECONDS,
		Math.ceil(windowSeconds / PROMETHEUS_MAX_POINTS),
	);
}

export function createPrometheusSource(deps: SourceDeps): HealthSource {
	return {
		kind: HealthSourceKind.PROMETHEUS,
		async query(input) {
			const { query } = input;
			const endpoint = httpsEndpoint(query);
			if (!endpoint.ok) return endpoint;
			const selector = cohortSelector(query, input.cohort);
			if (!selector.ok) return selector;
			const credential = await credentialFor(deps, query, input.campId);
			if (!credential.ok) return credential;
			const step = prometheusStepSeconds(input.fromMs, input.toMs);
			const start = Math.floor(input.fromMs / 1000 / step) * step;
			const end = Math.floor(input.toMs / 1000 / step) * step;
			const url = new URL(
				`${endpoint.value.pathname.replace(/\/$/, "")}/api/v1/query_range`,
				endpoint.value,
			);
			url.searchParams.set("query", query.query);
			url.searchParams.set("start", String(start));
			url.searchParams.set("end", String(end));
			url.searchParams.set("step", `${step}s`);
			const response = await requestJson(deps, {
				method: "GET",
				url,
				headers: credential.value,
				subject: query.name,
			});
			if (!response.ok) return response;
			const body = response.value;
			if (
				!isJsonObject(body) ||
				body.status !== "success" ||
				!isJsonObject(body.data) ||
				body.data.resultType !== "matrix" ||
				!isJsonArray(body.data.result)
			) {
				return invalid(
					query.name,
					"Prometheus answer is not a successful matrix",
				);
			}
			const series: Array<
				Readonly<{
					key: string;
					correlationKey: string;
					points: Array<{ value: number; observedAtMs: number }>;
				}>
			> = [];
			for (const item of body.data.result) {
				if (
					!isJsonObject(item) ||
					!isJsonObject(item.metric) ||
					!isJsonArray(item.values)
				)
					return invalid(query.name, "malformed Prometheus series");
				if (
					selector.value &&
					item.metric[selector.value.label] !== selector.value.value
				)
					continue;
				const points: Array<{ value: number; observedAtMs: number }> = [];
				for (const point of item.values) {
					if (!isJsonArray(point) || point.length !== 2)
						return invalid(query.name, "malformed Prometheus point");
					const value = sampleValue(point[1]);
					if (value === undefined) continue;
					if (!isJsonNumber(point[0]))
						return invalid(query.name, "malformed Prometheus timestamp");
					const observedAtMs = Math.round(point[0] * 1000);
					if (
						!Number.isSafeInteger(observedAtMs) ||
						observedAtMs < 0 ||
						observedAtMs > 8_640_000_000_000_000
					) {
						return invalid(query.name, "malformed Prometheus timestamp");
					}
					points.push({ value, observedAtMs });
				}
				points.sort((a, b) => a.observedAtMs - b.observedAtMs);
				const labels = Object.fromEntries(
					Object.entries(item.metric).filter(([name]) => name !== "__name__"),
				);
				series.push({
					key: stableKey(item.metric),
					correlationKey: createHash("sha256")
						.update(stableKey(labels))
						.digest("hex"),
					points,
				});
			}
			series.sort(byKey);
			const points = series.flatMap((item) => {
				const seriesKey = createHash("sha256").update(item.key).digest("hex");
				return item.points.map((point) => ({
					...point,
					seriesKey,
					correlationKey: item.correlationKey,
				}));
			});
			return {
				ok: true,
				value: {
					values: points.map((point) => point.value),
					fromMs: input.fromMs,
					toMs: input.toMs,
					points,
				},
			};
		},
	};
}
