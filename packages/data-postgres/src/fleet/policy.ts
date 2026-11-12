/**
 * The fleet policy: keep the writer, switch to a standby, or fail over.
 *
 * Engine-neutral, so it lives in `@hobo/backend-routing` (ADR-0179 phase 4c);
 * re-exported here under the names this package always had. See `decideFleet`
 * there for the rules.
 */
import type {
	FleetAllowance,
	FleetCandidate,
	FleetDecision,
	FleetFinancialModel,
	FleetObservation,
} from "@hobo/backend-routing";

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
} from "@hobo/backend-routing";

/** This package's names for the policy's records; the same parsed types. */
export type PostgresFleetObservation = FleetObservation;
export type PostgresFleetAllowance = FleetAllowance;
export type PostgresFleetFinancialModel = FleetFinancialModel;
export type PostgresFleetCandidate = FleetCandidate;
export type PostgresFleetDecision = FleetDecision;
