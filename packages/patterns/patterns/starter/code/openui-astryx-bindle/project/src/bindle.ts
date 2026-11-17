/**
 * High-value Bindle entry (template).
 * Budget, OpenFeature, and Harness integrations are supplied by the caller.
 */
// public-contract: the example Bindle name returned by createBindleManifest.
export const BINDLE_NAME = "openui-astryx-demo";

export const openFeatureFlags = {
	"app.visual.primary": {
		key: "app.visual.primary",
		defaultVariant: "on",
		description: "Primary OpenUI visual surface",
	},
} as const;

export function createBindleManifest() {
	return {
		name: BINDLE_NAME,
		ui: "openui+astryx",
		flags: Object.keys(openFeatureFlags),
		gherkin: ["features/visual.feature"],
	};
}
