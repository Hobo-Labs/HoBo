import type { CommandModule } from "@hobo/cli";
import type { EventStore } from "@hobo/core";
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
import { deployEnvironment } from "./compose.js";
import {
	type DeployTargetDescription,
	describeDeployTarget,
} from "./deploy-preflight.js";
import { loadHoboProfile } from "./hobo-profile.js";
import { isJsonString } from "./json.js";
import { buildMessagingDoctorSection } from "./messaging-doctor.js";
import { buildProjectionDoctorSection } from "./projection-diagnostics.js";
import { quarantineDiagnostics } from "./quarantine-diagnostics.js";

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
	// Explicit environment snapshot for tests or an embedding host. Without one,
	// use the same filtered process environment as the composed deploy path.
	readonly env?: Record<string, string | undefined>;
	readonly store?: EventStore;
}

// Plain ambient tokens are ignored by the composed deploy path; recommend an
// approved credential source instead of claiming an environment token works.
function remediationFor(target: DeployTargetDescription): string[] {
	if (target.live) return [];
	return target.activate.map((option) => {
		if (option.backend === "vercel" && option.missing.includes("VERCEL_TOKEN"))
			return "Configure an approved Vercel credential source; plain VERCEL_TOKEN in the process environment is ignored.";
		if (
			option.backend === "cloudflare" &&
			option.missing.includes("CLOUDFLARE_API_TOKEN")
		) {
			const account = option.missing.includes("CLOUDFLARE_ACCOUNT_ID")
				? " Set CLOUDFLARE_ACCOUNT_ID for cloudflare."
				: "";
			return `Configure an approved Cloudflare credential source; plain CLOUDFLARE_API_TOKEN in the process environment is ignored.${account}`;
		}
		return `Set ${option.missing.join(" + ")} to deploy for real via ${option.backend}.`;
	});
}

export function createDoctorCommand(
	deps: DoctorCommandDeps = {},
): CommandModule {
	return {
		run: async ({ emitProgress }) => {
			const env = deployEnvironment(deps.env);
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

			const bindingDelivery = buildBindingDeliveryDoctorSection(env);
			remediation.push(...bindingDelivery.remediation);

			const messaging = buildMessagingDoctorSection(env);
			remediation.push(...messaging.remediation);

			const projectionSection = await buildProjectionDoctorSection(
				deps.store,
				trailTenant,
				emitProgress,
			);
			const projections = projectionSection.diagnostic;
			remediation.push(...projectionSection.remediation);

			const quarantine = await quarantineDiagnostics(deps.store, trailTenant);
			if (quarantine.available) {
				if (
					quarantine.report.complete &&
					quarantine.report.findings.length === 0
				) {
					emitProgress("No quarantined events found.");
				}
				for (const finding of quarantine.report.findings) {
					emitProgress(
						`quarantine: ${finding.sourceStreamId}#${finding.offendingSeq} ${finding.foldKind} ${finding.fold} — ${finding.reason}`,
					);
				}
				if (quarantine.report.findings.length > 0) {
					remediation.push(
						"Investigate quarantined events and choose an explicit reprocess policy.",
					);
				}
				if (!quarantine.report.complete) {
					remediation.push(
						`Continue quarantine inspection with hobo inspect quarantines ${quarantine.report.nextPosition}.`,
					);
				}
			} else if (deps.store) {
				emitProgress(`Quarantine report unavailable: ${quarantine.reason}`);
				remediation.push(
					"Inspect the quarantine report failure and rerun hobo doctor.",
				);
			}

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
					projections: projections.available
						? { available: true, report: projections.json }
						: projections,
					quarantine: quarantine.available
						? { available: true, report: quarantine.json }
						: quarantine,
				},
			};
		},
	};
}
