/**
 * Template / componentize auto-wiring for web Bindles.
 * Zero required config beyond accepting defaults; HOBO_REPLAY=0 forces off.
 */
import { REPLAY_ENV_KILL, REPLAY_FLAG_KEY } from "./policy.js";
import { defaultPrivacyPolicy } from "./types.js";

export type ReplayAutowireSnippet = Readonly<{
	/** Import path for generated apps. */
	importLine: string;
	/** Init snippet inserted into web entry. */
	initSnippet: string;
	/** Bindle feature declaration (progressive; can disable per-env). */
	bindleFeature: Readonly<{
		key: typeof REPLAY_FLAG_KEY;
		localDefault: true;
		productionDefault: false;
		killEnv: typeof REPLAY_ENV_KILL;
	}>;
	/** Documented footprint budget. */
	performanceBudget: Readonly<{
		batchIntervalMs: number;
		batchSize: number;
		mainThreadBudgetMs: number;
		trackerOverheadKbGzip: number;
	}>;
}>;

/**
 * Returns the default auto-wire snippet for web UI templates.
 */
export function webReplayAutowire(): ReplayAutowireSnippet {
	const privacy = defaultPrivacyPolicy();
	return Object.freeze({
		importLine: `import { createDefaultLocalTracker, createMemoryDualFixtures } from "@hobo/replay";`,
		initSnippet: [
			`// HoBo Session Replay — local default on; set ${REPLAY_ENV_KILL}=0 to disable`,
			`const __hoboReplayStore = createMemoryDualFixtures();`,
			`const __hoboReplay = createDefaultLocalTracker({`,
			`  stationId: globalThis.__HOBO_STATION_ID__ ?? "station:local",`,
			`  store: __hoboReplayStore.blobs,`,
			`  index: __hoboReplayStore.index,`,
			`  env: typeof process !== "undefined" ? process.env : {},`,
			`});`,
			`// Privacy defaults: mask passwords/emails/tel + ${privacy.maskSelectors.length} selectors`,
		].join("\n"),
		bindleFeature: Object.freeze({
			key: REPLAY_FLAG_KEY,
			localDefault: true as const,
			productionDefault: false as const,
			killEnv: REPLAY_ENV_KILL,
		}),
		performanceBudget: Object.freeze({
			batchIntervalMs: 1000,
			batchSize: 50,
			mainThreadBudgetMs: 16,
			trackerOverheadKbGzip: 15,
		}),
	});
}

/**
 * componentize / extreme-template marker: feature is progressive.
 */
export function isReplayAutoWired(
	env: Readonly<Record<string, string | undefined>>,
): boolean {
	const kill = env[REPLAY_ENV_KILL];
	if (kill === "0" || kill === "false" || kill === "off") return false;
	return true;
}
