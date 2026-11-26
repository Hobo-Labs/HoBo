export const EXPERIENCE = "dx/convex-swaghaus-bindle";

export {
	assertAuthoringTransition,
	AUTHORING_TRANSITIONS,
	type AuthoringPhase,
	BindleAuthoringParseError,
	type BindleResourceKind,
	type BindleResourceView,
	type ConvexAppRoot,
	type EnvDependencyView,
	type EnvName,
	type EnvRouting,
	parseConvexAppRoot,
	parseEnvName,
	parseEnvRouting,
	parseResourceName,
	parseSwaghausBindle,
	type ResourceName,
	type SwaghausBindlePlan,
} from "./parse.ts";

export {
	type AuthorInput,
	authorSwaghausBindle,
	type BindleManifest,
	DEFAULT_WORKOS_ENDPOINT,
	draftSwaghausManifest,
} from "./authoring.ts";
