import type { CommandModule } from "@hobo/cli";
import {
	createContractAssertedDualFixtures,
	dualVerifyClaims,
	evaluateCanMigrate,
} from "@hobo/identity";
import { createStationClient, listStationIds } from "@hobo/stations";
import {
	createContractAssertedTrailFixtures,
	evaluateCanTrail,
	goldenIdentityHandsOff,
	identityContinuousTrail,
} from "@hobo/trails";
import { defaultHoboHome } from "./bare-metal-yard.js";
import { buildBindingDeliveryDoctorSection } from "./binding-delivery-doctor.js";
import {
	type DeployTargetDescription,
	describeDeployTarget,
} from "./deploy-preflight.js";
import { loadHoboProfile } from "./hobo-profile.js";
import { isJsonString } from "./json.js";
import { buildMessagingDoctorSection } from "./messaging-doctor.js";

interface StationDoctorReport {
	present: boolean;
	stationId?: string;
	bootstrapActive?: boolean;
	activeRailHash?: string;
	connectionCount?: number;
	doctorFlag?: string;
	stationIds?: readonly string[];
	remediation?: string;
}

export interface DoctorCommandDeps {
	// The environment consulted for deploy credentials. Defaults to `process.env`.
	// Injectable so a test can drive every backend lane without mutating the
	// ambient process environment.
	readonly env?: Record<string, string | undefined>;
}

// Turn the deploy-target description into operator-facing remediation lines.
// When already live, there is nothing to remediate; otherwise emit one line per
// real backend naming the exact env var(s) still missing to activate it — this
// is the answer to "how do I go live?" straight from the binary.
function remediationFor(target: DeployTargetDescription): string[] {
	if (target.live) return [];
	return target.activate.map(
		(option) =>
			`Set ${option.missing.join(" + ")} to deploy for real via ${option.backend}.`,
	);
}

// `hobo doctor` — report the deploy target the current environment selects and,
// when on the in-memory fallback, exactly what to set to go live. It calls the
// pure `describeDeployTarget` preflight (presence-only credential inspection),
// so it never reads a secret value and is safe to run anywhere. This makes the
// composed binary self-describing: the same precedence `hobo up` uses is
// surfaced as a diagnostic before anything is deployed.
export function createDoctorCommand(
	deps: DoctorCommandDeps = {},
): CommandModule {
	return {
		run: async ({ emitProgress }) => {
			const env = deps.env ?? process.env;
			const target = describeDeployTarget(env);
			emitProgress(target.summary);

			const hoboHome =
				isJsonString(env.HOBO_HOME) && env.HOBO_HOME.length > 0
					? env.HOBO_HOME
					: defaultHoboHome();
			const profile = loadHoboProfile(hoboHome);
			const stationId =
				(isJsonString(env.HOBO_STATION) && env.HOBO_STATION) ||
				profile?.defaultStation?.id;
			let stationReport: StationDoctorReport = {
				present: false,
				remediation: "hobo station init",
			};
			if (stationId) {
				try {
					const client = createStationClient({ hoboHome, stationId });
					const occ = client.occupancy();
					if (occ) {
						stationReport = {
							present: true,
							stationId,
							bootstrapActive: occ.bootstrapActive,
							...(occ.activeRailHash !== undefined
								? { activeRailHash: occ.activeRailHash }
								: undefined),
							connectionCount: occ.connectionCount,
							...(occ.bootstrapActive
								? { doctorFlag: "bootstrap-rail-active" }
								: undefined),
						};
					}
				} catch {
					stationReport = {
						present: false,
						stationId,
						remediation: "hobo station init",
					};
				}
			} else {
				const ids = listStationIds(hoboHome);
				if (ids.length > 0) {
					stationReport = {
						present: true,
						stationIds: ids,
						remediation: "set profile.defaultStation or HOBO_STATION",
					};
				}
			}

			const remediation = remediationFor(target);
			if (!stationReport.present) {
				remediation.push(
					"Run `hobo station init` for Station occupancy setup.",
				);
			} else if (stationReport.bootstrapActive === true) {
				remediation.push(
					"Bootstrap Rail still active — publish/activate a non-bootstrap Rail for production posture.",
				);
			}

			// Continuous identity migration dual fixtures (ADR-0070 extension) —
			// offline dual-consistency oracle; fidelity remains simulated without real IdPs.
			const dual = createContractAssertedDualFixtures({
				tenant:
					(isJsonString(env.HOBO_TENANT) && env.HOBO_TENANT) ||
					profile?.session?.tenant ||
					"local",
			});
			const dualOracle = dualVerifyClaims({
				mapping: dual.mapping,
				sourceClaims: dual.sourceClaims,
				targetClaims: dual.targetClaims,
				tenant: dual.tenant,
			});
			const canMigrate = evaluateCanMigrate({
				sourceAdapter: dual.sourceAdapter,
				targetAdapter: dual.targetAdapter,
				mapping: dual.mapping,
				dualOracleReady: dualOracle.ok,
			});
			const identityMigrationReport = {
				continuousDefault: true,
				bindleConfigRequired: false,
				dualFixtures: {
					label: dual.label,
					fidelity: dual.fidelity,
					principalRef: dual.principalRef,
					dualOracleOk: dualOracle.ok,
				},
				canMigrate: {
					ok: canMigrate.ok,
					summary: canMigrate.summary,
					dimension: "can-migrate" as const,
				},
			};
			if (!dualOracle.ok) {
				remediation.push(
					"Dual identity fixtures oracle failed — continuous migration dual path needs attention.",
				);
			}

			// Trails (continuous migration plane) — identity hands-off + local dual fixtures.
			const trailTenant =
				(isJsonString(env.HOBO_TENANT) && env.HOBO_TENANT) ||
				profile?.session?.tenant ||
				"local";
			const trailFx = createContractAssertedTrailFixtures({
				tenant: trailTenant,
			});
			const identityTrail = identityContinuousTrail();
			const canTrailIdentity = evaluateCanTrail({
				trail: identityTrail,
				dualOracleReady: dualOracle.ok,
				policyAllows: true,
			});
			const canTrailApp = trailFx.runner.plan(trailFx.appTrail);
			const handsOff = goldenIdentityHandsOff({
				bindleConfigRequired: false,
				continuousDefault: true,
			});
			const trailsReport = {
				fidelity: trailFx.fidelity,
				label: trailFx.label,
				identityContinuous: {
					trailId: identityTrail.id,
					bindleConfigRequired: false,
					canTrailOk: canTrailIdentity.ok,
					handsOff: handsOff.ok,
				},
				appSample: {
					trailId: trailFx.appTrail.id,
					canTrailOk: canTrailApp.canTrail.ok,
					identityContinuous: canTrailApp.identityContinuous,
				},
				canTrailDimension: "can-trail" as const,
			};
			if (!canTrailIdentity.ok || !handsOff.ok) {
				remediation.push(
					"Continuous identity Trail hands-off path failed — pure identity continuous must not require Bindle config.",
				);
			}

			// Binding delivery + 12-factor integrity (ADR-0141/0142).
			const bindingDelivery = buildBindingDeliveryDoctorSection(env);
			remediation.push(...bindingDelivery.remediation);

			// Messaging plane readiness (ADR-0138): Kafka + optional Dapr.
			const messaging = buildMessagingDoctorSection(env);
			remediation.push(...messaging.remediation);

			return {
				ok: true,
				status: target.live ? "live" : "in-memory",
				code: target.live ? "HOBO_DEPLOY_LIVE" : "HOBO_DEPLOY_MOCKED",
				message: target.summary,
				...(remediation.length > 0 ? { remediation } : undefined),
				data: {
					command: "doctor",
					backend: target.backend,
					live: target.live,
					activate: target.activate,
					station: stationReport,
					identityMigration: identityMigrationReport,
					trails: trailsReport,
					bindingDelivery: bindingDelivery.report,
					messaging: messaging.report,
				},
			};
		},
	};
}
