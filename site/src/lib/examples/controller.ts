import {
	parseExamplesCatalog,
	type ExampleCatalogEntry,
	type ExampleYard,
} from "./catalog-contract.js";
import {
	DEMO_POLICY_PRESETS,
	isDemoPolicyPresetId,
	resolveDemoPolicy,
	type DemoPolicyPresetId,
} from "./demo-policies.js";
import {
	isAnonSameOriginProvider,
	provisionAnonStationViaSameOrigin,
	shipOpenSaasViaSameOriginAnon,
} from "./anon-host-client.js";
import { provisionLakebedStationViaBroker } from "./lakebed-broker-client.js";
import {
	isProviderTempId,
	provisionProviderTempStation,
} from "./provider-temp-client.js";
import {
	primitivesForExample,
	recipesForExample,
	summarizeTerms,
	termsRows,
} from "./app-recipe-terms.js";
import {
	TARGET_CAPABILITY_PACKS,
	type TargetCapabilityPack,
} from "./target-capability-packs.js";
import { provisionVercelStationViaBroker } from "./vercel-broker-client.js";
import {
	applyLocalBridgeUrlOverride,
	createBridgeStationHost,
	deployViaLocalBridge,
	probeLocalBridge,
	provisionStationViaLocalBridge,
} from "./local-bridge-client.js";
import { browserWitRuntimeAvailable } from "./runtime/browser-station.js";
import { shipOpenSaasViaTemporaryAccounts } from "./opensaas-temporary-ship.js";
import { shipSwaghausViaTemporaryAccounts } from "./swaghaus-temporary-ship.js";
import {
	applyStationBrokerUrlOverride,
	provisionCloudflareStationViaBroker,
} from "./station-broker-client.js";
import {
	mergeBudgetPolicy,
	resolveDeployPlan,
	type BudgetPolicy,
	type DeployPlan,
	type DeploymentRole,
	type ResourceClass,
	type StationTarget,
} from "./policy-planner.js";
import {
	createBrowserWitStationHost,
	type BrowserWitStationHost,
} from "./runtime/browser-station.js";
import {
	emptyStationRegistry,
	loadStationRegistry,
	saveStationRegistry,
	type DeployedStation,
	type StationRegistry,
} from "./station-registry.js";
import { composePoolDeploySource } from "./yard-deploy-source-contract.js";

export { composePoolDeploySource } from "./yard-deploy-source-contract.js";
export {
	providerImportForTarget,
	yardDeployByTarget,
	type ProviderImportSpec,
	type YardDeploySource,
} from "./yard-deploy-source-contract.js";

interface TargetPack {
	readonly label: string;
	readonly resourceClass: StationTarget["resourceClass"];
	readonly canHostNow: boolean;
	readonly unavailableReason?: string;
	readonly native: readonly string[];
	/** Matching prefer-degrades (missing ports) — formerly ad-hoc lowers. */
	readonly lowers: Readonly<Record<string, string>>;
	readonly environment: string;
}

interface StationHostRuntime {
	readonly url: string;
	revoke(): void;
}

interface LiveHost {
	readonly station: DeployedStation;
	readonly role: DeploymentRole;
	readonly stationId: string;
	readonly exampleId: string;
	readonly exampleTitle: string;
	readonly runtime: StationHostRuntime;
	readonly frame: HTMLIFrameElement;
	/** Anonymous / Temporary Accounts claim URL when the host issued one. */
	readonly claimUrl?: string;
}

export const HOST_SANDBOX_TOKENS = ["allow-scripts"] as const;

/** Ship stays locked until Pool has at least one deployed station. */
export const SHIP_LOCKED_DEPLOY_LABEL = "Locked — deploy stations first";
export const SHIP_GATE_PLAN_LINE = "Deploy at least one station in Pool first.";
export const SHIP_RUNTIME_MISSING_LABEL = "Pick a local-bridge app";
export const SHIP_RUNTIME_MISSING_LINE =
	"Browser WIT runtime is not on this host (Pages omits ~25MB wasm). Pick OpenSaaS or Swaghaus, run `pnpm --filter hobo-site run examples:bridge`, then reload with ?bridge=http://127.0.0.1:8787.";

export function shipStationsReady(stationCount: number): boolean {
	return stationCount > 0;
}

/** Targets whose Environment Station hosts fully in-page on a static site. */
export const IN_PAGE_STATION_TARGETS = ["browser-wasm"] as const;

/** Static hosts (GitHub Pages) have no same-origin temp API; browser-wasm
 * stations still host in-page when the WIT runtime assets are published. */
export function canHostStationInPage(
	targetId: string,
	witRuntimeAvailable: boolean,
): boolean {
	return isInPageStationTarget(targetId) && witRuntimeAvailable;
}

function isInPageStationTarget(targetId: string): boolean {
	for (const id of IN_PAGE_STATION_TARGETS) {
		if (id === targetId) return true;
	}
	return false;
}

/** Pool outcome after per-target isolation: partial provision is success —
 * remote yards failing on a static host must not block in-page stations. */
export type PoolDeployOutcome = {
	readonly state: "stations-ready" | "failed";
	readonly line: string;
};

export function poolDeployOutcome(
	provisionedCount: number,
	failedTargetIds: readonly string[],
): PoolDeployOutcome {
	if (provisionedCount === 0) {
		return {
			state: "failed",
			line: `✗ no Environment Stations provisioned (${failedTargetIds.length} target(s) failed) — see remediation above`,
		};
	}
	if (failedTargetIds.length === 0) {
		return {
			state: "stations-ready",
			line: `✓ ${provisionedCount} Environment Station(s) ready · ship apps next`,
		};
	}
	return {
		state: "stations-ready",
		line: `✓ ${provisionedCount} Environment Station(s) ready · ${failedTargetIds.length} target(s) unavailable on this host (${failedTargetIds.join(", ")}) · ship apps next`,
	};
}

export function preferShipExampleId(
	catalog: readonly { readonly id: string; readonly deployKind: string }[],
	witRuntimeReady: boolean | null,
): string | undefined {
	if (witRuntimeReady === false) {
		return (
			catalog.find((entry) => entry.deployKind === "local-bridge")?.id ??
			catalog[0]?.id
		);
	}
	return catalog[0]?.id;
}

function toTargetPack(pack: TargetCapabilityPack): TargetPack {
	const mapped: TargetPack = {
		label: pack.label,
		resourceClass: pack.resourceClass,
		canHostNow: pack.canHostNow,
		native: pack.native,
		lowers: pack.preferDegrades,
		environment: pack.environment,
	};
	if (pack.unavailableReason) {
		return { ...mapped, unavailableReason: pack.unavailableReason };
	}
	return mapped;
}

const TARGET_PACKS: Readonly<Record<string, TargetPack>> = Object.fromEntries(
	Object.entries(TARGET_CAPABILITY_PACKS).map(([id, pack]) => [
		id,
		toTargetPack(pack),
	]),
);

let bridgeOnline = false;
let witRuntimeReady: boolean | null = null;

export async function bootExamplesConsole(): Promise<void> {
	const root = document.querySelector<HTMLElement>("[data-examples-console]");
	if (!root) return;
	const ui = requiredElements(root);
	const base = normalizeBase(root.dataset.base);
	const storage = globalThis.localStorage === undefined ? null : localStorage;
	const homeStationId = `station:browser:${crypto.randomUUID()}`;
	const bridgeOverride =
		new URL(window.location.href).searchParams.get("bridge") ??
		root.dataset.bridgeUrl ??
		null;
	applyLocalBridgeUrlOverride(bridgeOverride);
	const brokerOverride =
		new URL(window.location.href).searchParams.get("stationBroker") ??
		(root.dataset.stationBroker?.trim() ? root.dataset.stationBroker : null) ??
		null;
	applyStationBrokerUrlOverride(brokerOverride);

	const response = await fetch(`${base}examples/index.json`);
	if (!response.ok) throw new Error(`Examples catalog unavailable (${response.status})`);
	const catalog = parseExamplesCatalog(await response.json());
	if (catalog.length === 0) throw new Error("Examples catalog is empty");

	const health = await probeLocalBridge();
	bridgeOnline = health.ok && health.docker;

	const poolYards = catalog[0]!.topology.yards;
	let current = catalog[0]!;
	let registry = loadStationRegistry(storage, homeStationId);
	ui.stationId.textContent = registry.homeStationId;

	let poolSelected = defaultPoolTargetIds(poolYards);
	let demoPreset: DemoPolicyPresetId = "local-only";
	let appSelectedId: string | null = null;
	let stageHostId: string | null = null;
	let stationPlan = resolveStationDeployPlan(poolYards, poolSelected, demoPreset);
	let live: LiveHost[] = [];
	let busy = false;
	const revokeAnonymousStations = () => {
		// Same-origin anon hosts are disk-backed under site/.hobo-anon-hosts;
		// no blob: object URLs to revoke.
	};

	const selectedAppSet = () =>
		appSelectedId ? new Set([appSelectedId]) : new Set<string>();

	const activeStageHost = () =>
		live.find((host) => host.stationId === stageHostId) ?? live[0] ?? null;

	const shipExample = () => {
		const id = appSelectedId ?? catalog[0]!.id;
		return catalog.find((example) => example.id === id) ?? catalog[0]!;
	};

	const paintPoolSource = () => {
		const composed = composePoolDeploySource({
			provision: stationPlan.provision,
		});
		ui.poolSourcePath.textContent = composed.pathLabel;
		ui.poolSource.textContent = composed.source;
	};

	const paintShipSource = () => {
		if (!appSelectedId) {
			ui.shipSourcePath.textContent = "select an app";
			ui.shipSource.textContent = "// Pick an app to inspect Bindle source.";
			return;
		}
		const example = shipExample();
		current = example;
		ui.shipSourcePath.textContent = example.sourcePath;
		ui.shipSource.textContent = example.source;
	};

	const paintClaimCodes = (host: LiveHost | null) => {
		if (!host) {
			ui.claimCodes.hidden = true;
			ui.claimUrl.hidden = true;
			ui.claimUrl.removeAttribute("href");
			ui.claimUrl.textContent = "";
			ui.claimMissing.hidden = true;
			return;
		}
		ui.claimCodes.hidden = false;
		const claim = host.claimUrl ?? host.station.claimUrl;
		if (claim) {
			ui.claimUrl.hidden = false;
			ui.claimUrl.href = claim;
			ui.claimUrl.textContent = claim;
			ui.claimMissing.hidden = true;
		} else {
			ui.claimUrl.hidden = true;
			ui.claimUrl.removeAttribute("href");
			ui.claimUrl.textContent = "";
			ui.claimMissing.hidden = false;
		}
	};

	const setStageView = (view: "preview" | "logs") => {
		for (const button of root.querySelectorAll<HTMLButtonElement>("[data-view]")) {
			button.setAttribute("aria-pressed", String(button.dataset.view === view));
		}
		for (const panel of root.querySelectorAll<HTMLElement>("[data-view-panel]")) {
			panel.hidden = panel.dataset.viewPanel !== view;
		}
	};

	const setPoolView = (view: "policy" | "code") => {
		for (const button of root.querySelectorAll<HTMLButtonElement>("[data-pool-view]")) {
			button.setAttribute("aria-pressed", String(button.dataset.poolView === view));
		}
		for (const panel of root.querySelectorAll<HTMLElement>("[data-pool-panel]")) {
			panel.hidden = panel.dataset.poolPanel !== view;
		}
	};

	const gateBoards = (stationsReady: boolean, hasLive: boolean) => {
		const ship = root.querySelector<HTMLElement>('[data-board="ship"]');
		const liveBoard = root.querySelector<HTMLElement>('[data-board="live"]');
		const shipGate = root.querySelector<HTMLElement>("[data-ship-gate]");
		const shipBody = root.querySelector<HTMLElement>("[data-ship-body]");
		if (ship) {
			ship.toggleAttribute("inert", !stationsReady);
			ship.setAttribute("aria-disabled", String(!stationsReady));
			ship.dataset.locked = String(!stationsReady);
		}
		if (shipGate) shipGate.hidden = stationsReady;
		if (shipBody) shipBody.hidden = !stationsReady;
		if (liveBoard) {
			const lockLive = !stationsReady;
			liveBoard.toggleAttribute("inert", lockLive);
			liveBoard.setAttribute("aria-disabled", String(lockLive));
			liveBoard.dataset.locked = String(lockLive);
			liveBoard.dataset.hasHosts = String(hasLive);
		}
	};

	const appsPlanSummary = () => {
		if (registry.stations.length === 0) {
			return "Deploy at least one station before shipping apps.";
		}
		if (!appSelectedId) return "Pick an app from the list.";
		const example = catalog.find((entry) => entry.id === appSelectedId);
		if (!example) return "Pick an app from the list.";
		const plan = resolveExampleStationPlan(example, registry.stations);
		return `${example.title} · ${plan.provision.length} host slot(s)`;
	};

	const clearLive = () => {
		for (const host of live) {
			host.frame.remove();
			host.runtime.revoke();
		}
		live = [];
		stageHostId = null;
	};

	const persist = () => {
		saveStationRegistry(storage, registry);
	};

	const render = () => {
		stationPlan = resolveStationDeployPlan(poolYards, poolSelected, demoPreset);
		const focus = shipExample();
		current = focus;
		const stationsReady = shipStationsReady(registry.stations.length);
		const phase: "pool" | "ship" | "live" =
			!stationsReady ? "pool" : live.length === 0 ? "ship" : "live";
		ui.strip.dataset.phase = phase;
		gateBoards(stationsReady, live.length > 0);
		ui.stage.dataset.claimed = "false";
		const active = activeStageHost();
		ui.exampleTitle.textContent = active
			? `${active.exampleTitle} · ${active.station.label}`
			: live.length > 0
				? "Live hosts"
				: phase === "pool"
					? "Stage"
					: focus.title;
		ui.emptyTitle.textContent =
			phase === "pool"
				? "Pool stations first"
				: phase === "ship"
					? "Ship an app next"
					: "Preview a host";
		paintPoolSource();
		paintShipSource();
		paintClaimCodes(active);
		const shipLead = root.querySelector<HTMLElement>('[data-board="ship"] .ex-board-lead');
		if (shipLead) {
			shipLead.textContent = stationsReady
				? "Pick one app Bindle. Source stays on this board."
				: "Loads one catalog app onto every pooled station.";
		}
		if (!stationsReady) appSelectedId = null;

		renderDemoPresets(ui.demoPolicy, demoPreset, (id) => {
			if (busy) return;
			demoPreset = id;
			render();
		});
		renderYardSelect(
			ui.yardSelect,
			poolYards,
			poolSelected,
			stationPlan,
			(next, focusedTargetId) => {
				if (busy) return;
				poolSelected = next;
				if (focusedTargetId) {
					setPoolView("code");
				}
				render();
			},
		);
		renderStationSelect(ui.stationSelect, registry.stations);
		ui.removeStation.disabled = busy || ui.stationSelect.value === "";

		if (stationsReady) {
			if (!appSelectedId) {
				appSelectedId = preferShipExampleId(catalog, witRuntimeReady) ?? null;
			}
			renderAppSelect(ui.appSelect, catalog, appSelectedId, !busy, (id) => {
				if (busy || registry.stations.length === 0) return;
				if (live.length > 0) {
					clearLive();
					resetHostFrames(ui);
					ui.deployState.textContent = "idle";
					ui.terminal.replaceChildren(
						line("system", "App selection changed. Deploy apps again."),
					);
				}
				appSelectedId = id;
				paintShipSource();
				render();
			});
			renderAppsPolicy(ui.examplePolicy, catalog, selectedAppSet(), registry.stations);
			renderClaimTerms(ui, catalog, appSelectedId);
			ui.examplePlanLine.textContent = appsPlanSummary();
			const example = appSelectedId
				? catalog.find((entry) => entry.id === appSelectedId)
				: undefined;
			const shipSlots = example
				? resolveExampleStationPlan(example, registry.stations).provision.length
				: 0;
			const needsWit =
				example !== undefined && example.deployKind !== "local-bridge";
			const witMissing = needsWit && witRuntimeReady === false;
			ui.deployApps.disabled =
				busy || !appSelectedId || shipSlots === 0 || witMissing;
			ui.deployApps.firstElementChild!.textContent = witMissing
				? SHIP_RUNTIME_MISSING_LABEL
				: appSelectedId
					? `Deploy app (${shipSlots} host)`
					: "Deploy app";
			if (witMissing) {
				ui.examplePlanLine.textContent = SHIP_RUNTIME_MISSING_LINE;
			}
		} else {
			ui.appSelect.replaceChildren();
			const placeholder = document.createElement("option");
			placeholder.value = "";
			placeholder.textContent = "Select an app…";
			ui.appSelect.append(placeholder);
			ui.examplePolicy.replaceChildren();
			renderClaimTerms(ui, catalog, null);
			ui.examplePlanLine.textContent = SHIP_GATE_PLAN_LINE;
			ui.deployApps.disabled = true;
			ui.deployApps.firstElementChild!.textContent = SHIP_LOCKED_DEPLOY_LABEL;
		}

		renderPolicy(ui.stationPolicy, stationPlan);
		ui.stationPlanLine.textContent = `station plan: ${stationPlan.summary}`;
		ui.provisionPreview.textContent =
			phase === "pool"
				? "Pool stamps stations. Ship loads a Bindle. Preview lands here."
				: phase === "ship"
					? "Pick an app, then Deploy onto your stations."
					: "Toggle Preview ↔ Logs. Claim URLs show above when issued.";
		ui.deployStations.disabled = busy || stationPlan.provision.length === 0;
		ui.deployStations.firstElementChild!.textContent = `Deploy stations (${stationPlan.provision.length})`;

		renderLiveSelect(ui, live, stageHostId);
		const activePreview = activeStageHost();
		if (ui.openPreview) {
			if (activePreview) {
				ui.openPreview.hidden = false;
				ui.openPreview.href = activePreview.runtime.url;
				ui.openPreview.textContent = "Open";
			} else {
				ui.openPreview.hidden = true;
				ui.openPreview.removeAttribute("href");
			}
		}
	};

	void browserWitRuntimeAvailable(`${base}examples/runtime`).then((ok) => {
		witRuntimeReady = ok;
		render();
	});

	for (const button of root.querySelectorAll<HTMLButtonElement>("[data-view]")) {
		button.addEventListener("click", () => {
			const view = button.dataset.view === "logs" ? "logs" : "preview";
			const host = activeStageHost();
			if (host) stageHostId = host.stationId;
			setStageView(view);
		});
	}

	for (const button of root.querySelectorAll<HTMLButtonElement>("[data-pool-view]")) {
		button.addEventListener("click", () => {
			const view = button.dataset.poolView === "code" ? "code" : "policy";
			setPoolView(view);
			if (view === "code") paintPoolSource();
		});
	}

	ui.liveSelect.addEventListener("change", () => {
		const host = live.find((entry) => entry.stationId === ui.liveSelect.value);
		if (!host) return;
		stageHostId = host.stationId;
		render();
	});
	ui.removeStation.addEventListener("click", () => {
		if (busy) return;
		const id = ui.stationSelect.value;
		if (!id) return;
		clearLive();
		resetHostFrames(ui);
		registry = {
			...registry,
			stations: registry.stations.filter((station) => station.id !== id),
		};
		if (registry.stations.length === 0) appSelectedId = null;
		persist();
		ui.deployState.textContent = "idle";
		ui.terminal.replaceChildren(
			line("system", "Station removed. Redeploy apps onto remaining stations."),
		);
		render();
	});

	ui.clearStations.addEventListener("click", () => {
		if (busy) return;
		clearLive();
		resetHostFrames(ui);
		revokeAnonymousStations();
		registry = emptyStationRegistry(registry.homeStationId);
		appSelectedId = null;
		persist();
		ui.deployState.textContent = "idle";
		ui.terminal.replaceChildren(line("system", "Cleared deployed stations."));
		render();
	});

	ui.deployStations.addEventListener("click", async () => {
		if (busy) return;
		busy = true;
		ui.deployState.textContent = "deploying-stations";
		setStageView("logs");
		render();
		try {
			await writeTerminal(
				ui.terminal,
				"command",
				"$ hobo station up --from-pool --anonymous",
			);
			await writeTerminal(ui.terminal, "system", policyCommand(stationPlan));
			await writeTerminal(ui.terminal, "system", `→ ${stationPlan.summary}`);
			for (const skipped of stationPlan.skipped) {
				await writeTerminal(
					ui.terminal,
					"skip",
					`· policy-skip ${skipped.target.id}: ${skipped.detail}`,
				);
			}
			revokeAnonymousStations();
			const createdAt = new Date().toISOString();
			const nextStations: DeployedStation[] = [];
			const failedTargetIds: string[] = [];
			/** Static-host fallbacks when the same-origin temp API is absent:
			 * in-page browser station first (browser-wasm), then the optional
			 * local bridge (`?bridge=`) for docker/CLI-backed targets. */
			const provisionStationFallback = async (
				target: StationTarget,
				stationId: string,
			): Promise<{
				readonly endpointUrl?: string;
				readonly claimUrl?: string;
				readonly expiresAt?: string;
			} | null> => {
				const pack = packFor(target.id);
				if (witRuntimeReady === null) {
					witRuntimeReady = await browserWitRuntimeAvailable(
						`${base}examples/runtime`,
					);
				}
				if (canHostStationInPage(target.id, witRuntimeReady === true)) {
					await writeTerminal(
						ui.terminal,
						"success",
						`✓ in-page browser Environment Station ${stationId} · ${pack.label} (static host — WIT runtime served by this site)`,
					);
					return {};
				}
				const health = await probeLocalBridge();
				if (!health.ok) return null;
				try {
					const provisioned = await provisionStationViaLocalBridge({
						stationId,
						targetId: target.id,
						yardId: target.yardId,
						homeStationId: registry.homeStationId,
					});
					await writeTerminal(
						ui.terminal,
						"success",
						`✓ local-bridge Environment Station ${stationId} · ${pack.label}`,
					);
					await writeTerminal(
						ui.terminal,
						"system",
						`→ stationUrl ${provisioned.endpointUrl}`,
					);
					return { endpointUrl: provisioned.endpointUrl };
				} catch {
					return null;
				}
			};
			for (const { target } of stationPlan.provision) {
				const pack = packFor(target.id);
				const stationId = `${registry.homeStationId}:${target.id}`;
				await writeTerminal(
					ui.terminal,
					"system",
					`→ operator station bootstrap target=${target.id} yard=${target.yardId} class=${pack.resourceClass}`,
				);
				let endpointUrl: string | undefined;
				let claimUrl: string | undefined;
				let expiresAt: string | undefined;
				try {
				if (target.id === "cloudflare") {
					// Real Cloudflare Temporary Account via same-origin /api/cf-temp
					// (astro dev) or configured Temporary Accounts CORS relay.
					// Never stamp blob: and call it Cloudflare.
					const provisioned = await provisionCloudflareStationViaBroker({
						stationId,
					});
					endpointUrl = provisioned.stationUrl;
					claimUrl = provisioned.claimUrl;
					expiresAt = provisioned.expiresAt;
					await writeTerminal(
						ui.terminal,
						"success",
						`✓ Cloudflare temporary Environment Station ${stationId}`,
					);
					await writeTerminal(
						ui.terminal,
						"system",
						`→ stationUrl ${endpointUrl}`,
					);
					await writeTerminal(
						ui.terminal,
						"system",
						`→ claimUrl ${claimUrl} (expires ${expiresAt})`,
					);
				} else if (target.id === "lakebed") {
					const provisioned = await provisionLakebedStationViaBroker({
						stationId,
						pageUrl: window.location.href,
						basePath: base,
					});
					endpointUrl = provisioned.stationUrl;
					claimUrl = provisioned.claimUrl;
					expiresAt = provisioned.expiresAt;
					await writeTerminal(
						ui.terminal,
						"success",
						`✓ Lakebed anonymous Environment Station ${stationId}`,
					);
					await writeTerminal(
						ui.terminal,
						"system",
						`→ stationUrl ${endpointUrl}`,
					);
					await writeTerminal(
						ui.terminal,
						"system",
						`→ claimUrl ${claimUrl} (expires ${expiresAt})`,
					);
				} else if (target.id === "vercel") {
					const provisioned = await provisionVercelStationViaBroker({
						stationId,
						pageUrl: window.location.href,
						basePath: base,
					});
					endpointUrl = provisioned.stationUrl;
					claimUrl = provisioned.claimUrl;
					expiresAt = provisioned.expiresAt;
					await writeTerminal(
						ui.terminal,
						"success",
						`✓ Vercel Drop Environment Station ${stationId}`,
					);
					await writeTerminal(
						ui.terminal,
						"system",
						`→ stationUrl ${endpointUrl}`,
					);
					await writeTerminal(
						ui.terminal,
						"system",
						`→ claimUrl ${claimUrl} (expires ${expiresAt}) · https://vercel.com/docs/drop`,
					);
				} else if (!pack.canHostNow) {
					await writeTerminal(
						ui.terminal,
						"skip",
						`· fail-closed ${target.id}: ${pack.unavailableReason ?? "no temporary/agent provision"}`,
					);
					continue;
				} else if (isProviderTempId(target.id)) {
					const provisioned = await provisionProviderTempStation({
						providerId: target.id,
						stationId,
						pageUrl: window.location.href,
						basePath: base,
					});
					endpointUrl = provisioned.stationUrl;
					claimUrl = provisioned.claimUrl;
					expiresAt = provisioned.expiresAt;
					await writeTerminal(
						ui.terminal,
						"success",
						`✓ temporary Environment Station ${stationId} · ${pack.label}`,
					);
					await writeTerminal(
						ui.terminal,
						"system",
						`→ stationUrl ${endpointUrl}`,
					);
					await writeTerminal(
						ui.terminal,
						"system",
						`→ claimUrl ${claimUrl} (expires ${expiresAt})`,
					);
				} else if (isAnonSameOriginProvider(target.id)) {
					const provisioned = await provisionAnonStationViaSameOrigin({
						providerId: target.id,
						stationId,
						pageUrl: window.location.href,
						basePath: base,
					});
					endpointUrl = provisioned.endpointUrl;
					claimUrl = provisioned.claimUrl;
					expiresAt = provisioned.expiresAt;
					await writeTerminal(
						ui.terminal,
						"success",
						`✓ anonymous station ${stationId} · ${pack.label} (same-origin agent)`,
					);
					await writeTerminal(
						ui.terminal,
						"system",
						`→ stationUrl ${endpointUrl}`,
					);
					await writeTerminal(
						ui.terminal,
						"system",
						`→ claimUrl ${claimUrl} (expires ${expiresAt})`,
					);
				} else {
					await writeTerminal(
						ui.terminal,
						"success",
						`✓ local station ready ${stationId} · ${pack.label}`,
					);
				}
				} catch (error) {
					const fallback = await provisionStationFallback(target, stationId);
					if (fallback === null) {
						failedTargetIds.push(target.id);
						await writeTerminal(
							ui.terminal,
							"stderr",
							`✗ ${target.id}: ${error instanceof Error ? error.message : String(error)}`,
						);
						continue;
					}
					endpointUrl = fallback.endpointUrl;
					claimUrl = fallback.claimUrl;
					expiresAt = fallback.expiresAt;
				}
				const nextStation: DeployedStation = {
					id: stationId,
					targetId: target.id,
					yardId: target.yardId,
					providerId: target.providerId,
					policy: stationPlan.policy,
					label: pack.label,
					createdAt,
				};
				nextStations.push(
					withOptionalStationFields(nextStation, {
						endpointUrl,
						claimUrl,
						expiresAt,
					}),
				);
			}
			registry = { homeStationId: registry.homeStationId, stations: nextStations };
			persist();
			const outcome = poolDeployOutcome(nextStations.length, failedTargetIds);
			await writeTerminal(
				ui.terminal,
				outcome.state === "failed" ? "stderr" : "success",
				outcome.line,
			);
			ui.deployState.textContent = outcome.state;
		} catch (error) {
			await writeTerminal(
				ui.terminal,
				"stderr",
				`✗ ${error instanceof Error ? error.message : String(error)}`,
			);
			ui.deployState.textContent = "failed";
		} finally {
			busy = false;
			render();
		}
	});

	ui.deployApps.addEventListener("click", async () => {
		if (busy || registry.stations.length === 0 || !appSelectedId) return;
		busy = true;
		clearLive();
		resetHostFrames(ui);
		ui.terminal.replaceChildren();
		ui.deployState.textContent = "deploying";
		setStageView("logs");
		render();
		const opened: LiveHost[] = [];
		try {
			const example = catalog.find((entry) => entry.id === appSelectedId);
			if (!example) throw new Error("Selected app missing from catalog");
			if (
				example.deployKind !== "local-bridge" &&
				!(await browserWitRuntimeAvailable(`${base}examples/runtime`))
			) {
				throw new Error(SHIP_RUNTIME_MISSING_LINE);
			}
			const plan = resolveExampleStationPlan(example, registry.stations);
			await writeTerminal(
				ui.terminal,
				"command",
				example.deployKind === "local-bridge"
					? `$ local-bridge deploy --example ${example.id}`
					: `$ browser-station invoke --example ${example.id}`,
			);
			await writeTerminal(ui.terminal, "system", policyCommand(plan));
			await writeTerminal(ui.terminal, "system", `→ ${plan.summary}`);
			for (const skipped of plan.skipped) {
				await writeTerminal(
					ui.terminal,
					"skip",
					`· skip ${skipped.target.id}: ${skipped.detail}`,
				);
			}
			const provisioned = await mapConcurrent(
				plan.provision,
				plan.policy.maxConcurrent,
				async ({ target, role }) => {
					const station = registry.stations.find(
						(entry) => entry.targetId === target.id && entry.yardId === target.yardId,
					);
					if (!station) {
						throw new Error(`Selected station missing for target ${target.id}`);
					}
					const pack = packFor(target.id);
					await writeTerminal(
						ui.terminal,
						"system",
						`── ${example.title} · ${pack.label} (${role}) ──`,
					);
					const hostStationId = `${station.id}:${example.id}`;
					let runtime: StationHostRuntime;
					let hostClaimUrl: string | undefined = station.claimUrl;
					const frame = createHostFrame(
						`${example.title} on ${pack.label}`,
						example.deployKind === "local-bridge"
							? ["allow-scripts", "allow-same-origin", "allow-forms", "allow-popups"]
							: [...HOST_SANDBOX_TOKENS],
					);
					ui.junctionNote.before(frame);

					if (example.deployKind === "local-bridge") {
						const containers = example.bindleContainers;
						const webApp = example.bindleWebApp;
						const isWaspWebApp = webApp?.framework === "wasp";
						const isConvexWebApp = webApp?.framework === "convex";
						if (containers.length === 0 && !isWaspWebApp && !isConvexWebApp) {
							throw new Error(
								`${example.id}: Bindle declares neither b.web(waspApp|convexApp(...)) nor b.container({ image }) — refuse example-id side channel`,
							);
						}
						const cloudflareTemporary =
							target.id === "cloudflare" && (isWaspWebApp || isConvexWebApp);
						const sameOriginAnon =
							isWaspWebApp && isAnonSameOriginProvider(target.id);
						if (cloudflareTemporary && isConvexWebApp) {
							await writeTerminal(
								ui.terminal,
								"system",
								`→ convexApp(${webApp!.root}) → Temporary Accounts (convex deploy in that root)`,
							);
							const deployed = await shipSwaghausViaTemporaryAccounts({
								stationId: hostStationId,
								pageUrl: window.location.href,
								basePath: base,
								root: webApp!.root,
							});
							runtime = createBridgeStationHost(deployed.clientUrl);
							hostClaimUrl = deployed.claimUrl;
							frame.src = runtime.url;
							frame.hidden = false;
							await writeTerminal(
								ui.terminal,
								"success",
								`✓ ${example.title} · ${pack.label} · ${deployed.clientUrl}`,
							);
							await writeTerminal(
								ui.terminal,
								"system",
								`→ claimUrl ${deployed.claimUrl} (expires ${deployed.expiresAt})${deployed.mocked ? " · mock" : ""}`,
							);
						} else if (cloudflareTemporary && isWaspWebApp) {
							await writeTerminal(
								ui.terminal,
								"system",
								`→ waspApp(${webApp!.root}) → Temporary Accounts + Neon claimable db (zero keys)`,
							);
							const deployed = await shipOpenSaasViaTemporaryAccounts({
								stationId: hostStationId,
								pageUrl: window.location.href,
								basePath: base,
								root: webApp!.root,
							});
							runtime = createBridgeStationHost(deployed.clientUrl);
							hostClaimUrl = deployed.claimUrl;
							frame.src = runtime.url;
							frame.hidden = false;
							await writeTerminal(
								ui.terminal,
								"success",
								`✓ ${example.title} · ${pack.label} · ${deployed.clientUrl}`,
							);
							await writeTerminal(
								ui.terminal,
								"system",
								`→ claimUrl ${deployed.claimUrl} (expires ${deployed.expiresAt}) · db=${deployed.databaseMode}${deployed.databaseMocked ? " (mock)" : ""} · server=${deployed.serverMode}${deployed.serverMocked ? " (mock)" : ""} ${deployed.serverUrl} · dbClaim ${deployed.databaseClaimUrl}`,
							);
						} else if (sameOriginAnon) {
							await writeTerminal(
								ui.terminal,
								"system",
								`→ waspApp(${webApp!.root}) → same-origin agent host target=${target.id}`,
							);
							const deployed = await shipOpenSaasViaSameOriginAnon({
								providerId: target.id,
								stationId: hostStationId,
								pageUrl: window.location.href,
								basePath: base,
							});
							runtime = createBridgeStationHost(deployed.clientUrl);
							hostClaimUrl = deployed.claimUrl;
							frame.src = runtime.url;
							frame.hidden = false;
							await writeTerminal(
								ui.terminal,
								"success",
								`✓ ${example.title} · ${pack.label} · ${deployed.clientUrl}`,
							);
							await writeTerminal(
								ui.terminal,
								"system",
								`→ claimUrl ${deployed.claimUrl} (expires ${deployed.expiresAt}) · hostKind=${deployed.hostKind}`,
							);
						} else if (isConvexWebApp) {
							throw new Error(
								`${example.id}: Convex swaghaus Temporary self-host of official Convex OCI/binary is fail-closed under zero project API keys (see examples/convex-swaghaus/HOBO.md). Use Cloudflare Temporary ship path or HOBO_CONVEX_SWAGHAUS_MOCK=1.`,
							);
						} else {
						const health = await probeLocalBridge();
						bridgeOnline = health.ok;
						if (!bridgeOnline) {
							throw new Error(
								health.remediation ??
									"Local bridge required for Wasp OpenSaaS ship. Run: pnpm --filter hobo-site run examples:bridge",
							);
						}
						const localDockerTarget =
							target.id === "webernetes" || target.id === "lakebed";
						if (localDockerTarget && !health.docker) {
							throw new Error(
								"Docker required for Webernetes/Lakebed Wasp OpenSaaS realization (Postgres OCI + wasp build). Install Docker or ship via Cloudflare Temporary Accounts.",
							);
						}
						if (!isWaspWebApp) {
							throw new Error(
								`${example.id}: local bridge ship requires b.web(waspApp(root)) — container-only Bindles are not enough`,
							);
						}
						await writeTerminal(
							ui.terminal,
							"system",
							`→ bridge deploy waspApp(${webApp!.root}) db=${containers.find((c) => c.name === "db")?.image ?? "external/camp"} target=${target.id}`,
						);
						const deployed = await deployViaLocalBridge({
							exampleId: example.id,
							stationId: hostStationId,
							targetId: target.id,
							bindleWebApp: webApp!,
							bindleContainers: containers,
						});
						runtime = createBridgeStationHost(deployed.clientUrl);
						frame.src = runtime.url;
						frame.hidden = false;
						await writeTerminal(
							ui.terminal,
							"success",
							`✓ ${example.title} · ${pack.label} · ${deployed.clientUrl}`,
						);
						}
					} else {
						await writeTerminal(
							ui.terminal,
							"system",
							`→ browser station WIT guest example=${example.id} station=${station.id}`,
						);
						await writeTerminal(
							ui.terminal,
							"system",
							`→ component-local bindings: ${example.needs.join(", ")} · derived guest from Bindle web entrypoint`,
						);
						runtime = await createBrowserWitStationHost({
							assetBaseUrl: `${base}examples/runtime`,
							exampleId: example.id,
							title: example.title,
							ui: example.ui,
							stationId: hostStationId,
							targetLabel: `${pack.label} · ${pack.environment}`,
							runtime: example.runtime,
						});
						try {
							await waitForStation(frame, hostStationId, runtime.url);
						} catch (error) {
							frame.remove();
							runtime.revoke();
							throw error;
						}
						await writeTerminal(
							ui.terminal,
							"success",
							`✓ ${example.title} · ${pack.label} live · ${runtime.url}`,
						);
					}

					const host: LiveHost = {
						station,
						role,
						stationId: hostStationId,
						exampleId: example.id,
						exampleTitle: example.title,
						runtime,
						frame,
					};
					return hostClaimUrl ? { ...host, claimUrl: hostClaimUrl } : host;
				},
			);
			opened.push(...provisioned);
			live = opened;
			stageHostId = live[0]?.stationId ?? null;
			await writeTerminal(
				ui.terminal,
				"success",
				`✓ ${live.length} host(s) live · Preview ↔ Logs · claim URLs above when issued`,
			);
			ui.deployState.textContent = "live";
			if (live[0]) setStageView("preview");
		} catch (error) {
			for (const host of opened) {
				host.frame.remove();
				host.runtime.revoke();
			}
			live = [];
			stageHostId = null;
			await writeTerminal(
				ui.terminal,
				"stderr",
				`✗ ${error instanceof Error ? error.message : String(error)}`,
			);
			ui.deployState.textContent = "failed";
		} finally {
			busy = false;
			render();
		}
	});

	render();
	void current;
}

/** Station deploy from the provider pool + demo policy preset.
 * Selecting a yard widens the resource pool and replica budget so operator
 * Pool stamps are not blocked as not-in-resource-pool / over-replica.
 */
export function resolveStationDeployPlan(
	yards: readonly ExampleYard[],
	selected: ReadonlySet<string>,
	presetId: DemoPolicyPresetId,
): DeployPlan {
	const selectedYards = yards.filter((yard) => selected.has(yard.targetId));
	const base = resolveDemoPolicy(presetId);
	const resourcePool = new Set<ResourceClass>(base.resourcePool);
	for (const yard of selectedYards) {
		resourcePool.add(packFor(yard.targetId).resourceClass);
	}
	const policy = mergeBudgetPolicy({
		...base,
		resourcePool: [...resourcePool],
		maxReplicas: Math.max(base.maxReplicas, selectedYards.length || 1),
		redundancy:
			selectedYards.length > 1 && base.redundancy === "none"
				? "mirror"
				: base.redundancy,
	});
	return resolveDeployPlan(
		selectedYards.map(targetForYard),
		policy,
		yards.map((yard) => yard.id),
	);
}

/** Example deploy onto already-registered stations (filtered by example yards). */
export function resolveExampleStationPlan(
	example: ExampleCatalogEntry,
	stations: readonly DeployedStation[],
	selectedStationIds: ReadonlySet<string> = defaultSelectedStationIds(
		example,
		stations,
	),
): DeployPlan {
	const deployableYards = deployableYardIds(example);
	const eligible = stations.filter(
		(station) =>
			selectedStationIds.has(station.id) && deployableYards.has(station.yardId),
	);
	const policy = mergeBudgetPolicy(example.appPolicy, example.deploymentPolicy);
	const candidates = eligible.map((station) =>
		targetForYard({
			id: station.yardId,
			targetId: station.targetId,
			providerId: station.providerId,
			campId: `deployed:${station.id}`,
		}),
	);
	return resolveDeployPlan(candidates, policy, [...deployableYards]);
}

/** @deprecated Prefer resolveExampleStationPlan — kept for catalog policy fixtures. */
export function resolveExampleDeployPlan(
	example: ExampleCatalogEntry,
	selected: ReadonlySet<string> = defaultSelectedTargetIds(example),
) {
	const deployableYards = deployableYardIds(example);
	return resolveDeployPlan(
		example.topology.yards
			.filter(
				(yard) => selected.has(yard.targetId) && deployableYards.has(yard.id),
			)
			.map(targetForYard),
		mergeBudgetPolicy(example.appPolicy, example.deploymentPolicy),
		[...deployableYards],
	);
}

function targetForYard(yard: ExampleYard): StationTarget {
	const pack = packFor(yard.targetId);
	return {
		id: yard.targetId,
		yardId: yard.id,
		providerId: yard.providerId,
		resourceClass: pack.resourceClass,
		canHostNow: pack.canHostNow,
		unavailableReason: pack.unavailableReason,
		estimatedMonthlySpendUsd: 0,
	};
}

function packFor(id: string): TargetPack {
	const pack = TARGET_PACKS[id];
	if (!pack) throw new Error(`Unknown Environment Station target: ${id}`);
	return pack;
}

/** Whether a Pool yard target is selectable (never fake-disabled for CF/Railway). */
export function targetPackCanHostNow(targetId: string): boolean {
	return packFor(targetId).canHostNow;
}

export function defaultPoolTargetIds(yards: readonly ExampleYard[]): Set<string> {
	return new Set(
		yards
			.filter((yard) => packFor(yard.targetId).canHostNow)
			.map((yard) => yard.targetId),
	);
}

/** Browser WASM + Webernetes share one Pool dropdown option. */
export const LOCAL_YARD_TARGET_IDS = ["browser-wasm", "webernetes"] as const;

export type YardUiOption = {
	readonly id: string;
	readonly label: string;
	readonly targetIds: readonly string[];
	readonly title: string;
};

export function buildYardUiOptions(yards: readonly ExampleYard[]): YardUiOption[] {
	const byTarget = new Map(yards.map((yard) => [yard.targetId, yard] as const));
	const options: YardUiOption[] = [];
	const consumed = new Set<string>();
	const localTargets = LOCAL_YARD_TARGET_IDS.filter((id) => byTarget.has(id));
	if (localTargets.length > 0) {
		for (const id of localTargets) consumed.add(id);
		options.push({
			id: "local",
			label: "Local (Browser WASM · Webernetes)",
			targetIds: localTargets,
			title: "Browser Component Model + local Webernetes — one local lane",
		});
	}
	for (const yard of yards) {
		if (consumed.has(yard.targetId)) continue;
		const pack = packFor(yard.targetId);
		options.push({
			id: yard.targetId,
			label: pack.label,
			targetIds: [yard.targetId],
			title: `${yard.id} · ${pack.environment}`,
		});
	}
	return options;
}

export function yardOptionSelectionState(
	option: YardUiOption,
	selected: ReadonlySet<string>,
): "all" | "some" | "none" {
	let hit = 0;
	for (const id of option.targetIds) {
		if (selected.has(id)) hit += 1;
	}
	if (hit === 0) return "none";
	if (hit === option.targetIds.length) return "all";
	return "some";
}

export function toggleYardUiOption(
	selected: ReadonlySet<string>,
	option: YardUiOption,
): Set<string> {
	const next = new Set(selected);
	if (yardOptionSelectionState(option, selected) === "all") {
		for (const id of option.targetIds) next.delete(id);
	} else {
		for (const id of option.targetIds) next.add(id);
	}
	return next;
}

export function allYardUiTargetIds(options: readonly YardUiOption[]): string[] {
	return options.flatMap((option) => [...option.targetIds]);
}

export function yardSelectionSummary(
	options: readonly YardUiOption[],
	selected: ReadonlySet<string>,
): string {
	if (selected.size === 0) return "Select yards…";
	const fully = options.filter(
		(option) => yardOptionSelectionState(option, selected) === "all",
	);
	const allTargetCount = allYardUiTargetIds(options).length;
	// Local merges browser-wasm + webernetes into one option — summary must
	// report station/target count (matches Deploy stations N), not option count.
	if (fully.length === options.length && selected.size === allTargetCount) {
		return `All · ${selected.size} stations`;
	}
	if (fully.length === 0) return `${selected.size} station(s)`;
	const labels = fully.map((option) =>
		option.id === "local" ? "Local" : option.label,
	);
	if (labels.length <= 2) {
		return selected.size === labels.length
			? labels.join(", ")
			: `${labels.join(", ")} · ${selected.size} stations`;
	}
	return `${selected.size} stations · ${labels.slice(0, 2).join(", ")}…`;
}

export function defaultSelectedTargetIds(example: ExampleCatalogEntry): Set<string> {
	const allowed = deployableYardIds(example);
	return new Set(
		example.topology.yards
			.filter((yard) => allowed.has(yard.id))
			.map((yard) => yard.targetId),
	);
}

export function defaultSelectedStationIds(
	example: ExampleCatalogEntry,
	stations: readonly DeployedStation[],
): Set<string> {
	const allowed = deployableYardIds(example);
	return new Set(
		stations.filter((station) => allowed.has(station.yardId)).map((station) => station.id),
	);
}

function deployableYardIds(example: ExampleCatalogEntry): Set<string> {
	return new Set(
		example.topology.allowedYardIds ?? example.topology.junction.yardIds,
	);
}

function renderDemoPresets(
	container: HTMLSelectElement,
	current: DemoPolicyPresetId,
	onChange: (id: DemoPolicyPresetId) => void,
) {
	if (container.dataset.bound !== "1") {
		container.replaceChildren(
			...DEMO_POLICY_PRESETS.map((preset) => {
				const option = document.createElement("option");
				option.value = preset.id;
				option.textContent = `${preset.label} — ${preset.blurb}`;
				return option;
			}),
		);
		container.addEventListener("change", () => {
			if (isDemoPolicyPresetId(container.value)) onChange(container.value);
		});
		container.dataset.bound = "1";
	}
	container.value = current;
}

type YardOptionHint = {
	readonly hint: string;
	readonly title: string;
};

function yardOptionHint(
	option: YardUiOption,
	plan: DeployPlan,
): YardOptionHint {
	const roles: string[] = [];
	const skips: string[] = [];
	for (const targetId of option.targetIds) {
		const provision = plan.provision.find(({ target }) => target.id === targetId);
		const skipped = plan.skipped.find(({ target }) => target.id === targetId);
		if (provision) roles.push(provision.role);
		else if (skipped) skips.push(skipped.reason);
		else {
			const pack = packFor(targetId);
			skips.push(pack.canHostNow ? "ready" : "unavailable");
		}
	}
	if (roles.length > 0) {
		const unique = [...new Set(roles)];
		return {
			hint: unique.length === 1 ? unique[0]! : unique.join(" + "),
			title: option.title,
		};
	}
	return {
		hint: [...new Set(skips)].join(" · ") || "ready",
		title: option.title,
	};
}

function renderYardSelect(
	select: HTMLSelectElement,
	yards: readonly ExampleYard[],
	selected: ReadonlySet<string>,
	plan: DeployPlan,
	onChange: (next: Set<string>, focusedTargetId: string | null) => void,
) {
	type YardSelectState = { previous: Set<string> };
	type YardSelectElement = HTMLSelectElement & {
		_yardState?: YardSelectState;
	};
	// SAFETY: the yard picker stores prior selection on the select element instance.
	const selectState = select as YardSelectElement;
	const picker =
		select.closest<HTMLElement>("[data-yard-picker]") ??
		select.parentElement?.closest<HTMLElement>("[data-yard-picker]") ??
		null;
	const list =
		picker?.querySelector<HTMLElement>("[data-yard-list]") ??
		select
			.closest(".ex-field")
			?.querySelector<HTMLElement>("[data-yard-list]") ??
		null;
	const menu = picker?.querySelector<HTMLElement>("[data-yard-menu]") ?? null;
	const trigger =
		picker?.querySelector<HTMLButtonElement>("[data-yard-trigger]") ?? null;
	const summary =
		picker?.querySelector<HTMLElement>("[data-yard-summary]") ?? null;
	const allBtn = picker?.querySelector<HTMLButtonElement>("[data-yard-all]") ?? null;
	const noneBtn =
		picker?.querySelector<HTMLButtonElement>("[data-yard-none]") ?? null;

	const options = buildYardUiOptions(yards);

	const syncNative = (next: ReadonlySet<string>) => {
		select.replaceChildren(
			...yards.map((yard) => {
				const option = document.createElement("option");
				option.value = yard.targetId;
				option.selected = next.has(yard.targetId);
				option.textContent = `${packFor(yard.targetId).label}`;
				return option;
			}),
		);
	};

	const paintList = () => {
		if (!list) return;
		list.replaceChildren(
			...options.map((option) => {
				const meta = yardOptionHint(option, plan);
				const state = yardOptionSelectionState(option, selected);
				const button = document.createElement("button");
				button.type = "button";
				button.className = "ex-yard-option";
				button.dataset.yardOption = option.id;
				button.dataset.yardTargets = option.targetIds.join(",");
				button.setAttribute("role", "option");
				button.setAttribute(
					"aria-selected",
					state === "all" ? "true" : "false",
				);
				button.setAttribute(
					"aria-checked",
					state === "all" ? "true" : state === "some" ? "mixed" : "false",
				);
				button.setAttribute("aria-pressed", state === "all" ? "true" : "false");
				button.title = meta.title;
				const check = document.createElement("span");
				check.className = "ex-yard-check";
				check.setAttribute("aria-hidden", "true");
				const copy = document.createElement("span");
				copy.className = "ex-yard-copy";
				const label = document.createElement("span");
				label.className = "ex-yard-label";
				label.textContent = option.label;
				const hint = document.createElement("span");
				hint.className = "ex-yard-hint";
				hint.textContent = meta.hint;
				copy.append(label, hint);
				button.append(check, copy);
				return button;
			}),
		);
		if (summary) summary.textContent = yardSelectionSummary(options, selected);
	};

	const setMenuOpen = (open: boolean) => {
		if (!menu || !trigger) return;
		menu.hidden = !open;
		trigger.setAttribute("aria-expanded", open ? "true" : "false");
	};

	syncNative(selected);
	paintList();

	if (select.dataset.bound !== "1") {
		selectState._yardState = { previous: new Set(selected) };
		const emit = (next: Set<string>, focused: string | null) => {
			const state = selectState._yardState ?? { previous: new Set<string>() };
			state.previous = next;
			selectState._yardState = state;
			onChange(next, focused);
		};

		const applySelection = (next: Set<string>, focused: string | null) => {
			syncNative(next);
			emit(next, focused);
		};

		list?.addEventListener("click", (event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			const button = target.closest<HTMLButtonElement>("[data-yard-option]");
			if (!button?.dataset.yardOption) return;
			const targetIds = (button.dataset.yardTargets ?? "")
				.split(",")
				.map((id) => id.trim())
				.filter(Boolean);
			if (targetIds.length === 0) return;
			const option: YardUiOption = {
				id: button.dataset.yardOption,
				label: button.querySelector(".ex-yard-label")?.textContent ?? button.dataset.yardOption,
				targetIds,
				title: button.title,
			};
			const current = new Set(
				[...select.selectedOptions].map((entry) => entry.value).filter(Boolean),
			);
			const next = toggleYardUiOption(current, option);
			applySelection(next, option.targetIds[0] ?? null);
			setMenuOpen(false);
		});

		allBtn?.addEventListener("click", () => {
			const ids = [
				...(list?.querySelectorAll<HTMLElement>("[data-yard-targets]") ?? []),
			].flatMap((el) =>
				(el.dataset.yardTargets ?? "")
					.split(",")
					.map((id) => id.trim())
					.filter(Boolean),
			);
			applySelection(new Set(ids), null);
		});
		noneBtn?.addEventListener("click", () => {
			applySelection(new Set(), null);
		});

		trigger?.addEventListener("click", () => {
			const open = trigger.getAttribute("aria-expanded") === "true";
			setMenuOpen(!open);
		});

		document.addEventListener("pointerdown", (event) => {
			if (!picker || !menu || menu.hidden) return;
			const target = event.target;
			if (!(target instanceof Node) || picker.contains(target)) return;
			setMenuOpen(false);
		});
		document.addEventListener("keydown", (event) => {
			if (event.key === "Escape") setMenuOpen(false);
		});

		select.addEventListener("change", () => {
			const next = new Set(
				[...select.selectedOptions].map((option) => option.value).filter(Boolean),
			);
			const state = selectState._yardState ?? { previous: new Set<string>() };
			const added = [...next].find((id) => !state.previous.has(id));
			const removed = [...state.previous].find((id) => !next.has(id));
			emit(next, added ?? removed ?? [...next][0] ?? null);
		});
		select.dataset.bound = "1";
	} else if (selectState._yardState) {
		selectState._yardState.previous = new Set(selected);
	}
}

function renderStationSelect(
	select: HTMLSelectElement,
	stations: readonly DeployedStation[],
) {
	const current = select.value;
	if (stations.length === 0) {
		select.replaceChildren();
		const option = document.createElement("option");
		option.value = "";
		option.textContent = "None yet";
		select.append(option);
		return;
	}
	select.replaceChildren(
		...stations.map((station) => {
			const option = document.createElement("option");
			option.value = station.id;
			option.textContent = `${station.label} · ${station.yardId}`;
			return option;
		}),
	);
	if (stations.some((station) => station.id === current)) select.value = current;
}

function renderAppSelect(
	select: HTMLSelectElement,
	catalog: readonly ExampleCatalogEntry[],
	selectedId: string | null,
	interactive: boolean,
	onChange: (id: string | null) => void,
) {
	select.replaceChildren();
	const placeholder = document.createElement("option");
	placeholder.value = "";
	placeholder.textContent = "Select an app…";
	select.append(placeholder);
	for (const example of catalog) {
		const option = document.createElement("option");
		option.value = example.id;
		option.textContent =
			example.deployKind === "local-bridge"
				? `${example.title} · Wasp bridge`
				: example.title;
		option.selected = example.id === selectedId;
		select.append(option);
	}
	select.disabled = !interactive;
	if (select.dataset.bound !== "1") {
		select.addEventListener("change", () => {
			onChange(select.value || null);
		});
		select.dataset.bound = "1";
	}
	select.value = selectedId ?? "";
}

function renderAppsPolicy(
	container: HTMLElement,
	catalog: readonly ExampleCatalogEntry[],
	selected: ReadonlySet<string>,
	stations: readonly DeployedStation[],
) {
	const apps = catalog.filter((example) => selected.has(example.id));
	if (apps.length === 0) {
		container.replaceChildren();
		const term = document.createElement("dt");
		term.textContent = "app";
		const description = document.createElement("dd");
		description.textContent = "none selected";
		container.append(term, description);
		return;
	}
	const app = apps[0]!;
	const slots = resolveExampleStationPlan(app, stations).provision.length;
	const fields: Array<[string, string]> = [
		["app", app.title],
		["deploy", app.deployKind],
		["host slots", String(slots)],
	];
	container.replaceChildren(
		...fields.flatMap(([name, value]) => {
			const term = document.createElement("dt");
			term.textContent = name;
			const description = document.createElement("dd");
			description.textContent = value;
			return [term, description];
		}),
	);
}

/**
 * Disclose the claim terms before the deploy button, not after.
 *
 * The terms come from the shipped recipes (`recipe-terms.json`, generated from
 * `@hobo/recipes`), matched to the app by the primitives it declares. When no
 * shipped recipe covers the app the panel says so rather than showing the
 * terms of a recipe that would deploy something else.
 */
function renderClaimTerms(
	ui: {
		termsFold: HTMLElement;
		termsSummary: HTMLElement;
		termsLead: HTMLElement;
		terms: HTMLElement;
	},
	catalog: readonly ExampleCatalogEntry[],
	appId: string | null,
): void {
	const example = appId
		? catalog.find((entry) => entry.id === appId)
		: undefined;
	if (!example) {
		ui.termsFold.hidden = true;
		ui.terms.replaceChildren();
		ui.termsSummary.textContent = "";
		ui.termsLead.textContent = "";
		return;
	}

	const [best] = recipesForExample(example);
	ui.termsFold.hidden = false;
	if (!best) {
		ui.termsSummary.textContent = "— no shipped recipe covers this app yet";
		ui.termsLead.textContent = `This app needs ${primitivesForExample(example).join(
			", ",
		)}. No recipe in the catalog places all of them, so there are no claim terms to show.`;
		ui.terms.replaceChildren();
		return;
	}

	ui.termsSummary.textContent = `— ${summarizeTerms(best)}`;
	ui.termsLead.textContent = `${best.displayName}: ${best.description}`;
	ui.terms.replaceChildren(
		...termsRows(best).flatMap(([label, value]) => {
			const term = document.createElement("dt");
			term.textContent = label;
			const description = document.createElement("dd");
			description.textContent = value;
			return [term, description];
		}),
	);
}

function renderPolicy(container: HTMLElement, plan: DeployPlan) {
	const fields = [
		["redundancy", plan.policy.redundancy],
		["maxReplicas", String(plan.policy.maxReplicas)],
		["maxConcurrent", String(plan.policy.maxConcurrent)],
		["resourcePool", `[${plan.policy.resourcePool.join(", ")}]`],
		["routing", plan.policy.routing],
		["spendCap", `$${plan.policy.monthlySpendCapUsd}/month`],
	];
	container.replaceChildren(
		...fields.flatMap(([name, value]) => {
			const term = document.createElement("dt");
			term.textContent = name;
			const description = document.createElement("dd");
			description.textContent = value;
			return [term, description];
		}),
	);
}

function renderLiveSelect(
	ui: ReturnType<typeof requiredElements>,
	live: readonly LiveHost[],
	stageHostId: string | null,
) {
	ui.hostEmpty.hidden = live.length > 0;
	ui.hostTabs.hidden = live.length === 0;
	const activeId =
		(stageHostId && live.some((host) => host.stationId === stageHostId)
			? stageHostId
			: null) ??
		live[0]?.stationId ??
		null;

	if (live.length === 0) {
		ui.liveSelect.replaceChildren();
		const option = document.createElement("option");
		option.value = "";
		option.textContent = "None yet";
		ui.liveSelect.append(option);
		ui.placement.textContent = "Ship an app to see placement.";
		ui.hostTabs.replaceChildren();
		ui.junctionNote.hidden = true;
		return;
	}

	ui.liveSelect.replaceChildren(
		...live.map((host) => {
			const option = document.createElement("option");
			option.value = host.stationId;
			option.textContent = `${host.exampleTitle} · ${host.station.label} · ${host.role}`;
			option.selected = host.stationId === activeId;
			return option;
		}),
	);

	ui.placement.textContent = live
		.map((host) => {
			const pack = packFor(host.station.targetId);
			return `${host.exampleTitle} → ${pack.label} · ${host.role}`;
		})
		.join(" · ");

	ui.hostTabs.replaceChildren(
		...live.map((host) => {
			const button = document.createElement("button");
			button.type = "button";
			button.textContent = `${host.exampleTitle} · ${host.station.label}`;
			button.setAttribute("aria-pressed", String(host.stationId === activeId));
			button.addEventListener("click", () => {
				ui.liveSelect.value = host.stationId;
				ui.liveSelect.dispatchEvent(new Event("change"));
			});
			host.frame.hidden = host.stationId !== activeId;
			return button;
		}),
	);
	ui.junctionNote.hidden = false;
	ui.junctionNote.textContent = `Placement preview: ${live.length} host(s) · Open for a new tab`;
}

function createHostFrame(
	title: string,
	sandboxTokens: readonly string[] = HOST_SANDBOX_TOKENS,
): HTMLIFrameElement {
	const frame = document.createElement("iframe");
	frame.dataset.hostFrame = "";
	frame.title = title;
	for (const token of sandboxTokens) frame.sandbox.add(token);
	frame.hidden = true;
	return frame;
}

function waitForStation(
	frame: HTMLIFrameElement,
	stationId: string,
	url: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = window.setTimeout(
			() => done(new Error(`station bootstrap timed out: ${stationId}`)),
			20_000,
		);
		const receive = (event: MessageEvent) => {
			if (
				event.source !== frame.contentWindow ||
				event.data?.source !== "hobo-browser-station" ||
				event.data?.stationId !== stationId
			) {
				return;
			}
			done(
				event.data.status === "ready"
					? undefined
					: new Error(event.data.message ?? `station failed: ${stationId}`),
			);
		};
		function done(error?: Error) {
			window.clearTimeout(timeout);
			window.removeEventListener("message", receive);
			if (error) reject(error);
			else resolve();
		}
		window.addEventListener("message", receive);
		frame.src = url;
	});
}

function resetHostFrames(ui: ReturnType<typeof requiredElements>) {
	for (const frame of document.querySelectorAll<HTMLIFrameElement>("[data-host-frame]")) {
		frame.remove();
	}
	ui.hostTabs.replaceChildren();
	ui.hostTabs.hidden = true;
	ui.hostEmpty.hidden = false;
	ui.junctionNote.hidden = true;
	ui.claimCodes.hidden = true;
	ui.claimUrl.hidden = true;
	ui.claimUrl.removeAttribute("href");
	ui.claimUrl.textContent = "";
	ui.claimMissing.hidden = true;
	ui.stage.dataset.claimed = "false";
}

export async function mapConcurrent<T, R>(
	values: readonly T[],
	concurrency: number,
	map: (value: T) => Promise<R>,
): Promise<R[]> {
	const output: R[] = [];
	let next = 0;
	let failed = false;
	let failure: unknown;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, values.length) }, async () => {
			while (!failed && next < values.length) {
				const index = next++;
				try {
					output[index] = await map(values[index]!);
				} catch (error) {
					failed = true;
					failure = error;
				}
			}
		}),
	);
	if (failed) throw failure;
	return output;
}

function withOptionalStationFields(
	station: DeployedStation,
	fields: {
		readonly endpointUrl?: string;
		readonly claimUrl?: string;
		readonly expiresAt?: string;
	},
): DeployedStation {
	let next = station;
	if (fields.endpointUrl) next = { ...next, endpointUrl: fields.endpointUrl };
	if (fields.claimUrl) next = { ...next, claimUrl: fields.claimUrl };
	if (fields.expiresAt) next = { ...next, expiresAt: fields.expiresAt };
	return next;
}

export function normalizeBase(value: string | undefined): string {
	return `${value ?? "/"}`.replace(/\/?$/u, "/");
}

/** Last selected app wins for Ship Bindle focus; fall back to first selected / catalog. */
export function pickSourceFocusId(
	selected: ReadonlySet<string>,
	focusId: string | null | undefined,
	fallbackId: string,
): string {
	if (focusId && selected.has(focusId)) return focusId;
	const first = [...selected][0];
	return first ?? fallbackId;
}

/**
 * Prefer the active live host's example when present; otherwise Ship selection.
 */
export function resolveStageSourceFocusId(input: {
	readonly selected: ReadonlySet<string>;
	readonly sourceFocusId: string | null | undefined;
	readonly fallbackId: string;
	readonly activeLiveExampleId?: string | null;
}): string {
	if (input.activeLiveExampleId) return input.activeLiveExampleId;
	return pickSourceFocusId(input.selected, input.sourceFocusId, input.fallbackId);
}

function policyCommand(plan: DeployPlan): string {
	return `→ policy redundancy=${plan.policy.redundancy} maxReplicas=${plan.policy.maxReplicas} pool=[${plan.policy.resourcePool.join(",")}] routing=${plan.policy.routing} spendCap=$${plan.policy.monthlySpendCapUsd}`;
}

async function writeTerminal(container: HTMLElement, kind: string, text: string) {
	container.append(line(kind, text));
	container.scrollTop = container.scrollHeight;
	await new Promise((resolve) => window.setTimeout(resolve, 90));
}

function line(kind: string, text: string) {
	const item = document.createElement("p");
	item.className = kind;
	item.textContent = text;
	return item;
}

function requiredElements(root: HTMLElement) {
	const get = <T extends Element>(selector: string) => {
		const element = root.querySelector<T>(selector);
		if (!element) throw new Error(`Examples UI is missing ${selector}`);
		return element;
	};
	return {
		stage: get<HTMLElement>("[data-stage]"),
		strip: get<HTMLElement>("[data-phase]"),
		exampleTitle: get<HTMLElement>("[data-example-title]"),
		hostTabs: get<HTMLElement>("[data-host-tabs]"),
		hostEmpty: get<HTMLElement>("[data-host-empty]"),
		emptyTitle: get<HTMLElement>("[data-empty-title]"),
		openPreview: root.querySelector<HTMLAnchorElement>("[data-open-preview]"),
		provisionPreview: get<HTMLElement>("[data-provision-preview]"),
		junctionNote: get<HTMLElement>("[data-junction-note]"),
		poolSourcePath: get<HTMLElement>("[data-pool-source-path]"),
		poolSource: get<HTMLElement>("[data-pool-source]"),
		shipSourcePath: get<HTMLElement>("[data-ship-source-path]"),
		shipSource: get<HTMLElement>("[data-ship-source]"),
		claimCodes: get<HTMLElement>("[data-claim-codes]"),
		claimUrl: get<HTMLAnchorElement>("[data-claim-url]"),
		claimMissing: get<HTMLElement>("[data-claim-missing]"),
		stationId: get<HTMLElement>("[data-station-id]"),
		yardSelect: get<HTMLSelectElement>("[data-yard-select]"),
		demoPolicy: get<HTMLSelectElement>("[data-demo-policy]"),
		stationPolicy: get<HTMLElement>("[data-station-policy]"),
		stationPlanLine: get<HTMLElement>("[data-station-plan-line]"),
		deployStations: get<HTMLButtonElement>("[data-deploy-stations]"),
		stationSelect: get<HTMLSelectElement>("[data-station-select]"),
		removeStation: get<HTMLButtonElement>("[data-remove-station]"),
		clearStations: get<HTMLButtonElement>("[data-clear-stations]"),
		appSelect: get<HTMLSelectElement>("[data-app-select]"),
		examplePolicy: get<HTMLElement>("[data-example-policy]"),
		examplePlanLine: get<HTMLElement>("[data-example-plan-line]"),
		termsFold: get<HTMLElement>("[data-terms-fold]"),
		termsSummary: get<HTMLElement>("[data-terms-summary]"),
		termsLead: get<HTMLElement>("[data-terms-lead]"),
		terms: get<HTMLElement>("[data-terms]"),
		deployApps: get<HTMLButtonElement>("[data-deploy-apps]"),
		deployState: get<HTMLElement>("[data-deploy-state]"),
		terminal: get<HTMLElement>("[data-terminal]"),
		liveSelect: get<HTMLSelectElement>("[data-live-select]"),
		placement: get<HTMLElement>("[data-placement]"),
	};
}

export type { BudgetPolicy, DeployedStation, StationRegistry, BrowserWitStationHost };
