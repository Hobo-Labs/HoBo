/**
 * Station occupancy sidecars for a coding session.
 * Dashboard is in-process and dies with the owner. Evidence is occupancy-
 * scoped: persist mode detaches it so Bindle /dev, session.complete(), and
 * TTY quit do not stop the SPA.
 */
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FeatureFlagStore } from "@hobo/identity";
import { inspectBindleProject } from "./bindle-inspect.js";
import { startEvalSidecar } from "./eval-sidecar-server.js";
import { startExperimentSidecar } from "./experiment-sidecar-server.js";
import { startHistorySidecar } from "./history-sidecar-server.js";
import { isJsonNumber, isJsonString } from "./json.js";
import { startKmsSidecar } from "./kms-sidecar-server.js";
import {
	loopbackFetchUrl,
	type OccupancyNameScope,
	preferNamedEndpoint,
} from "./occupancy-endpoints.js";
import { startRolloutSidecar } from "./rollout-sidecar-server.js";
import { startSessionControlServer } from "./session-control-server.js";
import { startLocalDashboard } from "./session-dashboard.js";
import { CODE_CAMP_ID, userCampId } from "./session-resources.js";
import {
	type AuthedStationView,
	describeAuthedStationSession,
} from "./station-session.js";
import { startStatusSidecar } from "./status-sidecar-server.js";

// public-contract: Station sidecar discovery snapshot
export const STATION_SIDECARS_SCHEMA = "hobo.code.station-sidecars/v1" as const;

export interface StationSidecarSnapshot {
	readonly schema: typeof STATION_SIDECARS_SCHEMA;
	readonly stationId: string;
	readonly environment: string;
	readonly dashboardUrl: string;
	readonly evidenceUrl: string;
	readonly evidenceReportUrl: string;
	readonly evidenceControlsUrl: string;
	readonly evidencePid?: number;
	readonly otlpHttpUrl: string;
	readonly evalsUrl?: string;
	readonly rolloutUrl?: string;
	readonly experimentUrl?: string;
	readonly kmsUrl?: string;
	readonly historyUrl?: string;
	readonly statusUrl?: string;
	readonly startedAt: string;
}

interface RunningSidecars {
	readonly sidecars: StationSidecars;
	refs: number;
}

const running = new Map<string, RunningSidecars>();

function sidecarKey(hoboHome: string, stationId: string): string {
	return `${hoboHome}::${stationId}`;
}

export interface StationSidecars extends StationSidecarSnapshot {
	readonly close: () => Promise<void>;
}

export interface StartStationSidecarsOptions {
	readonly hoboHome: string;
	readonly projectRoot?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly dashboardPort?: number;
	readonly evidencePort?: number;
	readonly otlpHttpPort?: number;
	readonly otlpGrpcPort?: number;
	readonly evalsPort?: number;
	readonly rolloutPort?: number;
	readonly experimentPort?: number;
	readonly kmsPort?: number;
	readonly historyPort?: number;
	readonly statusPort?: number;
	readonly ensureLocalLogin?: boolean;
	/**
	 * Detach Evidence as a Station occupancy process. Default on for TTY /
	 * startCodeSession / /dev attach. Tests omit this to stay in-process.
	 */
	readonly persistEvidence?: boolean;
}

function safeLabel(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

export function stationSidecarsPath(
	hoboHome: string,
	stationId: string,
): string {
	return join(hoboHome, "stations", safeLabel(stationId), "sidecars.json");
}

export function sidecarsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.HOBO_CODE_SIDECARS?.trim();
	if (raw === "0" || raw === "false" || raw === "off") return false;
	return true;
}

export function readStationSidecars(
	hoboHome: string,
	stationId: string,
): StationSidecarSnapshot | null {
	const path = stationSidecarsPath(hoboHome, stationId);
	if (!existsSync(path)) return null;
	try {
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		const parsed = JSON.parse(
			readFileSync(path, "utf8"),
			// SAFETY: parsed or fixture value is the named domain type after this assertion.
		) as Partial<StationSidecarSnapshot>;
		if (parsed.schema !== STATION_SIDECARS_SCHEMA) return null;
		if (!isJsonString(parsed.dashboardUrl)) return null;
		if (!isJsonString(parsed.evidenceUrl)) return null;
		// SAFETY: parsed or fixture value is the named domain type after this assertion.
		return parsed as StationSidecarSnapshot;
	} catch {
		return null;
	}
}

function writeSnapshot(
	hoboHome: string,
	snapshot: StationSidecarSnapshot,
): void {
	const path = stationSidecarsPath(hoboHome, snapshot.stationId);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, {
		mode: 0o600,
	});
	mkdirSync(join(hoboHome, "runtime", "code"), { recursive: true });
	writeFileSync(
		join(hoboHome, "runtime", "code", "evidence-controls-url"),
		`${snapshot.evidenceControlsUrl}\n`,
		{ mode: 0o600 },
	);
}

function occupancy(
	hoboHome: string,
	env: NodeJS.ProcessEnv,
	ensureLocalLogin: boolean,
): AuthedStationView {
	return describeAuthedStationSession({
		hoboHome,
		env,
		ensureLocalLogin,
	});
}

function pidAlive(pid: number | undefined): boolean {
	if (pid === undefined || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function occupancyScope(view: AuthedStationView): OccupancyNameScope {
	return {
		tenant: view.tenant,
		environment: view.environment,
		...(view.project !== undefined ? { project: view.project } : undefined),
		...(view.branch !== undefined ? { branch: view.branch } : undefined),
	};
}

function publishSidecarUrls(
	snapshot: StationSidecarSnapshot,
	scope: OccupancyNameScope,
): StationSidecarSnapshot {
	return {
		...snapshot,
		dashboardUrl: snapshot.dashboardUrl
			? preferNamedEndpoint(snapshot.dashboardUrl, "dashboard", scope)
			: snapshot.dashboardUrl,
		evidenceUrl: preferNamedEndpoint(snapshot.evidenceUrl, "evidence", scope),
		evidenceReportUrl: preferNamedEndpoint(
			snapshot.evidenceReportUrl,
			"evidence",
			scope,
		),
		evidenceControlsUrl: preferNamedEndpoint(
			snapshot.evidenceControlsUrl,
			"evidence",
			scope,
		),
		otlpHttpUrl: snapshot.otlpHttpUrl
			? preferNamedEndpoint(snapshot.otlpHttpUrl, "otlp", scope)
			: snapshot.otlpHttpUrl,
		...(snapshot.evalsUrl
			? {
					evalsUrl: preferNamedEndpoint(snapshot.evalsUrl, "evals", scope),
				}
			: undefined),
		...(snapshot.rolloutUrl
			? {
					rolloutUrl: preferNamedEndpoint(
						snapshot.rolloutUrl,
						"rollout",
						scope,
					),
				}
			: undefined),
		...(snapshot.experimentUrl
			? {
					experimentUrl: preferNamedEndpoint(
						snapshot.experimentUrl,
						"experiment",
						scope,
					),
				}
			: undefined),
		...(snapshot.kmsUrl
			? {
					kmsUrl: preferNamedEndpoint(snapshot.kmsUrl, "kms", scope),
				}
			: undefined),
		...(snapshot.historyUrl
			? {
					historyUrl: preferNamedEndpoint(
						snapshot.historyUrl,
						"history",
						scope,
					),
				}
			: undefined),
		...(snapshot.statusUrl
			? {
					statusUrl: preferNamedEndpoint(snapshot.statusUrl, "status", scope),
				}
			: undefined),
	};
}

async function evidenceReachable(url: string): Promise<boolean> {
	try {
		const response = await fetch(loopbackFetchUrl(url), {
			signal: AbortSignal.timeout(400),
		});
		return response.ok;
	} catch {
		return false;
	}
}

export async function isStationEvidenceLive(
	snapshot: StationSidecarSnapshot | null,
): Promise<boolean> {
	if (!snapshot?.evidenceUrl) return false;
	if (snapshot.evidencePid !== undefined && !pidAlive(snapshot.evidencePid)) {
		return false;
	}
	return evidenceReachable(snapshot.evidenceUrl);
}

function resolveTsxLoader(from: string): string | undefined {
	let dir = dirname(from);
	for (let i = 0; i < 8; i += 1) {
		const loader = join(dir, "node_modules", "tsx", "dist", "loader.mjs");
		if (existsSync(loader)) return loader;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

function evidenceWorkerEntry() {
	const here = dirname(fileURLToPath(import.meta.url));
	const sibling = join(here, "evidence-sidecar-main.js");
	if (existsSync(sibling)) return { entry: sibling, ts: false };
	// Vitest loads this module from src/; prefer pretest's compiled worker
	// so occupancy tests do not spawn a tsx compile per sidecar.
	const pkgDist = join(here, "..", "dist", "evidence-sidecar-main.js");
	if (existsSync(pkgDist)) return { entry: pkgDist, ts: false };
	return { entry: join(here, "evidence-sidecar-main.ts"), ts: true };
}

interface PersistentEvidence {
	readonly url: string;
	readonly reportUrl: string;
	readonly controlsUrlTemplate: string;
	readonly pid: number;
	readonly close: () => Promise<void>;
}

async function spawnPersistentEvidence(
	options: StartStationSidecarsOptions,
): Promise<PersistentEvidence> {
	const readyPath = join(
		tmpdir(),
		`hobo-evidence-${process.pid}-${Date.now()}.json`,
	);
	const worker = evidenceWorkerEntry();
	const tsx = worker.ts ? resolveTsxLoader(worker.entry) : undefined;
	const args =
		worker.ts && tsx ? ["--import", tsx, worker.entry] : [worker.entry];
	const child = spawn(process.execPath, args, {
		detached: true,
		stdio: "ignore",
		env: {
			...process.env,
			...options.env,
			HOBO_HOME: options.hoboHome,
			HOBO_CODE_SIDECARS: "0",
			HOBO_CODE_SIDECAR_READY: readyPath,
			HOBO_CODE_SIDECAR_ROOT: options.projectRoot ?? process.cwd(),
			HOBO_CODE_EVIDENCE_PORT: String(options.evidencePort ?? 8788),
		},
	});
	if (child.pid === undefined) {
		throw new Error("failed to spawn Station Evidence sidecar");
	}
	child.unref();
	const deadline = Date.now() + 12_000;
	while (Date.now() < deadline) {
		if (existsSync(readyPath)) {
			try {
				// SAFETY: parsed or fixture value is the named domain type after this assertion.
				const parsed = JSON.parse(readFileSync(readyPath, "utf8")) as {
					readonly url?: string;
					readonly reportUrl?: string;
					readonly controlsUrl?: string;
					readonly pid?: number;
				};
				if (
					isJsonString(parsed.url) &&
					isJsonString(parsed.reportUrl) &&
					isJsonString(parsed.controlsUrl) &&
					isJsonNumber(parsed.pid)
				) {
					try {
						unlinkSync(readyPath);
					} catch {
						// ready file is best-effort
					}
					const pid = parsed.pid;
					const pidFile = options.env?.HOBO_CODE_SIDECAR_PIDFILE?.trim();
					if (pidFile) {
						writeFileSync(pidFile, `${String(pid)}\n`, { mode: 0o600 });
					}
					return {
						url: parsed.url,
						reportUrl: parsed.reportUrl,
						controlsUrlTemplate: parsed.controlsUrl,
						pid,
						close: async () => {},
					};
				}
			} catch {
				// still writing
			}
		}
		if (child.exitCode !== null) {
			throw new Error(
				`Station Evidence sidecar exited (${child.exitCode ?? "unknown"})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	try {
		killProcessGroup(child.pid, "SIGTERM");
	} catch {
		// already gone
	}
	throw new Error("Station Evidence sidecar did not become ready");
}

function killProcessGroup(
	pid: number,
	signal: NodeJS.Signals = "SIGTERM",
): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// occupancy teardown is best-effort
		}
	}
}

function killEvidencePid(pid: number | undefined): void {
	if (!pidAlive(pid) || pid === undefined) return;
	killProcessGroup(pid, "SIGTERM");
}

async function waitForEvidenceDown(
	url: string | undefined,
	pid: number | undefined,
): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const reachable = url ? await evidenceReachable(url) : false;
		if (!reachable && !pidAlive(pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
	if (pidAlive(pid) && pid !== undefined) {
		killProcessGroup(pid, "SIGKILL");
	}
}

async function startEvidenceServer(
	options: StartStationSidecarsOptions,
): Promise<
	PersistentEvidence | Awaited<ReturnType<typeof startSessionControlServer>>
> {
	if (options.persistEvidence === true) {
		const disk = readStationSidecars(
			options.hoboHome,
			occupancy(
				options.hoboHome,
				options.env ?? process.env,
				options.ensureLocalLogin !== false,
			).stationId,
		);
		if ((await isStationEvidenceLive(disk)) && disk) {
			return {
				url: disk.evidenceUrl,
				reportUrl: disk.evidenceReportUrl,
				controlsUrlTemplate: disk.evidenceControlsUrl,
				pid: disk.evidencePid ?? 0,
				close: async () => {},
			};
		}
		return spawnPersistentEvidence(options);
	}
	const projectRoot = options.projectRoot ?? process.cwd();
	try {
		return await startSessionControlServer({
			hoboHome: options.hoboHome,
			projectRoot,
			port: options.evidencePort ?? 8788,
		});
	} catch {
		return startSessionControlServer({
			hoboHome: options.hoboHome,
			projectRoot,
			port: 0,
		});
	}
}

export async function startStationSidecars(
	options: StartStationSidecarsOptions,
): Promise<StationSidecars> {
	const env = options.env ?? process.env;
	const view = occupancy(
		options.hoboHome,
		env,
		options.ensureLocalLogin !== false,
	);
	if (!view.loggedIn || view.stationId.length === 0) {
		throw new Error(
			view.message || "Not logged in — run: hobo-code auth login",
		);
	}
	const key = sidecarKey(options.hoboHome, view.stationId);
	const existing = running.get(key);
	if (existing) {
		existing.refs += 1;
		return existing.sidecars;
	}

	// Evidence is required for the whole occupancy. Dashboard is best-effort.
	const persist = options.persistEvidence === true;
	const evidence = await startEvidenceServer({
		...options,
		persistEvidence: persist,
	});
	const evidencePid =
		"pid" in evidence && isJsonNumber(evidence.pid) && evidence.pid > 0
			? evidence.pid
			: undefined;
	let dashboardUrl = "";
	let otlpHttpUrl = "";
	let evalsUrl: string | undefined;
	let rolloutUrl: string | undefined;
	let experimentUrl: string | undefined;
	let kmsUrl: string | undefined;
	let historyUrl: string | undefined;
	let statusUrl: string | undefined;
	let closeDashboard: () => Promise<void> = async () => {};
	let closeEvals: () => Promise<void> = async () => {};
	let closeRollout: () => Promise<void> = async () => {};
	let closeExperiment: () => Promise<void> = async () => {};
	let closeKms: () => Promise<void> = async () => {};
	let closeHistory: () => Promise<void> = async () => {};
	let closeStatus: () => Promise<void> = async () => {};
	try {
		const dashboard = await startLocalDashboard({
			hoboHome: options.hoboHome,
			env,
			port: options.dashboardPort ?? 8787,
			otlpHttpPort: options.otlpHttpPort ?? 0,
			otlpGrpcPort: options.otlpGrpcPort ?? 0,
			evidenceControl: {
				async stop() {
					killEvidencePid(evidencePid);
					await waitForEvidenceDown(evidence.url, evidencePid);
				},
				async start() {
					const disk = readStationSidecars(options.hoboHome, view.stationId);
					if (await isStationEvidenceLive(disk)) {
						return;
					}
					await startEvidenceServer({
						...options,
						persistEvidence: persist,
					});
				},
			},
			...(options.projectRoot !== undefined
				? { projectRoot: options.projectRoot }
				: undefined),
		});
		dashboardUrl = dashboard.url;
		otlpHttpUrl = dashboard.otlpHttpUrl;
		closeDashboard = () => dashboard.close();
	} catch {
		// Evidence still runs.
	}

	try {
		const inspected =
			options.projectRoot !== undefined
				? inspectBindleProject(options.projectRoot)
				: undefined;
		const evals = await startEvalSidecar({
			campId: inspected ? userCampId(inspected.name) : CODE_CAMP_ID,
			port: options.evalsPort ?? 0,
			...(options.projectRoot !== undefined
				? { projectDir: options.projectRoot }
				: undefined),
		});
		evalsUrl = evals.url;
		closeEvals = () => evals.close();
	} catch {
		// Default suite still exists on the inventory; listener is best-effort.
	}

	try {
		const flags = new FeatureFlagStore();
		const rollout = await startRolloutSidecar({
			store: flags,
			port: options.rolloutPort ?? 0,
		});
		rolloutUrl = rollout.url;
		closeRollout = () => rollout.close();
		const experiment = await startExperimentSidecar({
			store: flags,
			port: options.experimentPort ?? 0,
		});
		experimentUrl = experiment.url;
		closeExperiment = () => experiment.close();
		const kms = await startKmsSidecar({
			port: options.kmsPort ?? 0,
			persistDir: join(
				options.hoboHome,
				"stations",
				safeLabel(view.stationId),
				"kms",
			),
		});
		kmsUrl = kms.url;
		closeKms = () => kms.close();
		const history = await startHistorySidecar({
			hoboHome: options.hoboHome,
			stationId: view.stationId,
			environment: view.environment,
			port: options.historyPort ?? 0,
		});
		historyUrl = history.url;
		closeHistory = () => history.close();
	} catch (error) {
		await closeDashboard();
		await closeEvals();
		await closeRollout();
		await closeExperiment();
		await closeKms();
		await closeHistory();
		throw error;
	}

	// Status page is default-on but best-effort: a broken status listener must
	// never take the occupancy down (ADR-0077 default sidecar, opt-out via
	// HOBO_CODE_SIDECARS=0 with the rest of the fleet).
	try {
		const status = await startStatusSidecar({
			hoboHome: options.hoboHome,
			stationId: view.stationId,
			environment: view.environment,
			port: options.statusPort ?? 0,
		});
		statusUrl = status.url;
		closeStatus = () => status.close();
	} catch {
		// The fleet still runs without its status page.
	}

	const snapshot = publishSidecarUrls(
		{
			schema: STATION_SIDECARS_SCHEMA,
			stationId: view.stationId,
			environment: view.environment,
			dashboardUrl,
			evidenceUrl: evidence.url,
			evidenceReportUrl: evidence.reportUrl,
			evidenceControlsUrl: evidence.controlsUrlTemplate,
			...(evidencePid !== undefined ? { evidencePid } : undefined),
			otlpHttpUrl,
			...(evalsUrl !== undefined ? { evalsUrl } : undefined),
			...(rolloutUrl !== undefined ? { rolloutUrl } : undefined),
			...(experimentUrl !== undefined ? { experimentUrl } : undefined),
			...(kmsUrl !== undefined ? { kmsUrl } : undefined),
			...(historyUrl !== undefined ? { historyUrl } : undefined),
			...(statusUrl !== undefined ? { statusUrl } : undefined),
			startedAt: new Date().toISOString(),
		},
		occupancyScope(view),
	);
	writeSnapshot(options.hoboHome, snapshot);

	const sidecars: StationSidecars = {
		...snapshot,
		async close() {
			const held = running.get(key);
			if (!held || held.sidecars !== sidecars) return;
			held.refs -= 1;
			if (held.refs > 0) return;
			running.delete(key);
			await closeDashboard();
			await closeEvals();
			await closeRollout();
			await closeExperiment();
			await closeKms();
			await closeHistory();
			await closeStatus();
			if (persist) return;
			const path = stationSidecarsPath(options.hoboHome, view.stationId);
			await evidence.close();
			if (existsSync(path)) {
				try {
					const current = readStationSidecars(options.hoboHome, view.stationId);
					if (current?.evidenceUrl === snapshot.evidenceUrl) {
						unlinkSync(path);
					}
				} catch {
					// discovery is best-effort
				}
			}
		},
	};
	running.set(key, { sidecars, refs: 1 });
	return sidecars;
}

/** Attach to the Station Evidence sidecar. Never owns its lifetime. */
export async function attachStationSidecars(
	options: StartStationSidecarsOptions,
): Promise<StationSidecarSnapshot> {
	const env = options.env ?? process.env;
	const view = occupancy(
		options.hoboHome,
		env,
		options.ensureLocalLogin !== false,
	);
	if (!view.loggedIn || view.stationId.length === 0) {
		throw new Error(
			view.message || "Not logged in — run: hobo-code auth login",
		);
	}
	const key = sidecarKey(options.hoboHome, view.stationId);
	const live = running.get(key)?.sidecars;
	if (live) return live;
	const disk = readStationSidecars(options.hoboHome, view.stationId);
	if ((await isStationEvidenceLive(disk)) && disk) return disk;
	// Start if this Station has no Evidence yet. Caller must not close —
	// Evidence belongs to the occupancy, not /dev.
	return startStationSidecars({ ...options, persistEvidence: true });
}

/** Close in-process dashboard/refs. Persist Evidence stays up. */
export async function releaseStationSidecars(
	hoboHome: string,
	stationId: string,
): Promise<void> {
	const key = sidecarKey(hoboHome, stationId);
	const held = running.get(key);
	if (!held) return;
	await held.sidecars.close();
}

/** Tear down occupancy sidecars regardless of attach count. */
export async function stopStationSidecars(
	hoboHome: string,
	stationId: string,
): Promise<void> {
	const key = sidecarKey(hoboHome, stationId);
	const held = running.get(key);
	const disk = readStationSidecars(hoboHome, stationId);
	if (held) {
		held.refs = 1;
		await held.sidecars.close();
	}
	const evidencePid = disk?.evidencePid ?? held?.sidecars.evidencePid;
	const evidenceUrl = disk?.evidenceUrl ?? held?.sidecars.evidenceUrl;
	killEvidencePid(evidencePid);
	await waitForEvidenceDown(evidenceUrl, evidencePid);
	const path = stationSidecarsPath(hoboHome, stationId);
	if (existsSync(path)) {
		try {
			unlinkSync(path);
		} catch {
			// discovery is best-effort
		}
	}
}

export function formatSidecarStrap(
	sidecars: StationSidecarSnapshot,
): readonly string[] {
	const chips: string[] = [];
	if (sidecars.dashboardUrl) {
		chips.push(`dash:${new URL(sidecars.dashboardUrl).host}`);
	}
	if (sidecars.evidenceUrl) {
		chips.push(`evidence:${new URL(sidecars.evidenceUrl).host}`);
	}
	if (sidecars.evalsUrl) {
		chips.push(`evals:${new URL(sidecars.evalsUrl).host}`);
	}
	if (sidecars.rolloutUrl) {
		chips.push(`rollout:${new URL(sidecars.rolloutUrl).host}`);
	}
	if (sidecars.experimentUrl) {
		chips.push(`experiment:${new URL(sidecars.experimentUrl).host}`);
	}
	if (sidecars.kmsUrl) {
		chips.push(`kms:${new URL(sidecars.kmsUrl).host}`);
	}
	if (sidecars.historyUrl) {
		chips.push(`history:${new URL(sidecars.historyUrl).host}`);
	}
	if (sidecars.statusUrl) {
		chips.push(`status:${new URL(sidecars.statusUrl).host}`);
	}
	return chips;
}
