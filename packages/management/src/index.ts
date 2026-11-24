export {
	type CredentialAuditProjectionView,
	type CredentialAuditSource,
	type DeploymentViewProjectionView,
	type DeploymentViewSource,
	projectCredentialAudit,
	projectDeploymentView,
} from "./cloud-projections.js";
export {
	connectionAuthorize,
	connectionCreate,
	connectionGet,
	connectionList,
	connectionRevoke,
	connectionRotate,
} from "./connection-ops.js";
export {
	createManagementContext,
	type ManagementContext,
	resolveDefaultStationId,
} from "./context.js";
export {
	decodeCredentialAuditView,
	encodeCredentialAuditView,
} from "./credential-audit-wire.js";
export {
	brokerStatus,
	doctorSnapshot,
	projectYardSnapshot,
} from "./projections.js";
export {
	errResult,
	type ManagementResult,
	okResult,
} from "./result.js";
export {
	type StationInitInput,
	stationDown,
	stationInit,
	stationRailsActivate,
	stationRailsApprove,
	stationRailsList,
	stationRailsPublish,
	stationStatus,
	stationUp,
} from "./station-ops.js";
export type {
	BrokerStatusView,
	ConnectorActivityView,
	ConnectorStatusSource,
	DoctorView,
	ManagementActor,
	ManagementHome,
	MeteringView,
	PublicConnectionView,
	RailPublicView,
	TrafficRateSource,
	YardProjectionSnapshot,
} from "./types.js";
export { toPublicConnection, toRailPublicView } from "./types.js";

export const HOBO_MANAGEMENT_PACKAGE = "@hobo/management";
