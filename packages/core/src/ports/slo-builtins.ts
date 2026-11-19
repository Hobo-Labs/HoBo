import { cloneAsJson } from "../json.js";
import {
	OPEN_SLO_API_VERSION,
	parseSloDefinition,
	SLO_SCHEMA,
	type SloDefinition,
	type SloTelemetry,
} from "./slo.js";

export type SloMetricQueries = Readonly<{
	good: SloTelemetry;
	total: SloTelemetry;
}>;
export type BuiltInSloQueries = Readonly<{
	deploySuccess: SloMetricQueries;
	controlPlaneAvailability: SloMetricQueries;
}>;

export function createBuiltInSloDefinitions(
	queries: BuiltInSloQueries,
): readonly SloDefinition[] {
	const definitions = [
		{
			name: "deploy-success-rate",
			service: "deployment-control-plane",
			objective: "deploy success rate",
			target: 0.99,
			queries: queries.deploySuccess,
		},
		{
			name: "control-plane-availability",
			service: "control-plane",
			objective: "control-plane availability",
			target: 0.999,
			queries: queries.controlPlaneAvailability,
		},
	];
	return Object.freeze(
		definitions.map((item) =>
			parseSloDefinition(
				cloneAsJson({
					schema: SLO_SCHEMA,
					apiVersion: OPEN_SLO_API_VERSION,
					kind: "SLO",
					metadata: {
						name: item.name,
						labels: { "hobo.dev/scope": "control-plane" },
					},
					spec: {
						service: item.service,
						indicator: {
							ratioMetric: {
								counter: true,
								good: { telemetry: item.queries.good },
								total: { telemetry: item.queries.total },
							},
						},
						timeWindow: { duration: "30d", isRolling: true },
						budgetingMethod: "Occurrences",
						objectives: [{ displayName: item.objective, target: item.target }],
						burnRateThresholds: [
							{
								name: "fast-burn",
								threshold: 14.4,
								lookbackWindow: "5m",
								samplingInterval: "1m",
							},
							{
								name: "slow-burn",
								threshold: 2,
								lookbackWindow: "1h",
								samplingInterval: "5m",
							},
						],
					},
				}),
			),
		),
	);
}
