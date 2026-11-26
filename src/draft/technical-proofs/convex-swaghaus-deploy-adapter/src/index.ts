export const PROOF_ID = "convex-swaghaus-deploy-adapter";

export {
	assertShipTransition,
	type ConvexAppRoot,
	ConvexDeployParseError,
	type DeploymentName,
	type DeploymentUrl,
	type DeployMode,
	type DeployReceipt,
	type DeployRequest,
	type EnvName,
	type ImpedanceCode,
	type ImpedanceRecord,
	type ImpedanceSeverity,
	parseConvexAppRoot,
	parseDeploymentName,
	parseDeploymentUrl,
	parseDeployReceipt,
	parseDeployRequest,
	parseEnvName,
	parseImpedanceRecords,
	parseShipPreflight,
	SHIP_TRANSITIONS,
	type ShipPhase,
	type ShipPreflight,
} from "./parse.ts";

export {
	DEFAULT_DEPLOYMENT_NAME,
	preflightSwaghausShip,
	shipSwaghausConvexApp,
	type ShipInput,
	type ShipOutcome,
} from "./ship.ts";
