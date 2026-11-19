import type {
	FleetAllowance,
	FleetCandidate,
	FleetDecision,
	FleetFinancialModel,
	FleetObservation,
} from "@hobo/backend-fleet";

export {
	DEFAULT_FLEET_POLICY,
	decideFleet,
	FLEET_ACTIONS,
	FLEET_FEASIBILITIES,
	FLEET_OVERAGE_KINDS,
	type FleetAction,
	type FleetBackendHealth,
	type FleetBudgetCheck,
	type FleetBudgetRequest,
	type FleetBudgetVerdict,
	type FleetDecisionInput,
	type FleetFeasibility,
	type FleetOverageKind,
	type FleetPolicy,
	type FleetUsageMeasurement,
	parseFleetFinancialModel,
	parseFleetPolicy,
} from "@hobo/backend-fleet";

export type PostgresFleetObservation = FleetObservation;
export type PostgresFleetAllowance = FleetAllowance;
export type PostgresFleetFinancialModel = FleetFinancialModel;
export type PostgresFleetCandidate = FleetCandidate;
export type PostgresFleetDecision = FleetDecision;
