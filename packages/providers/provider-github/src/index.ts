export {
	GITHUB_API_KINDS,
	GITHUB_API_VERSION,
	GITHUB_COM_API_ORIGIN,
	GITHUB_MAX_RESPONSE_BYTES,
	GITHUB_TIMEOUT_MS,
	type GithubApiBinding,
	type GithubApiKind,
	type GithubApiTarget,
	parseGithubApiBinding,
} from "./api.js";
export {
	GITHUB_PAGES_REFUSAL_REASONS,
	GITHUB_PAGES_SITE_PRODUCT_ID,
	GITHUB_PROVIDER_ID,
	GithubPagesRefusal,
	type GithubPagesRefusalReason,
	githubProductRefusal,
} from "./errors.js";
export {
	createGithubPagesResolvers,
	GITHUB_PAGES_DELETE_ACTIONS,
	GITHUB_PAGES_DIRECTIVES,
	GITHUB_PAGES_PUBLISH_MODES,
	type GithubArtifactBlobReader,
	type GithubPagesPublishMode,
	type GithubPagesResolverOptions,
	githubResolverRegistry,
} from "./resolver.js";
export {
	gitBlobSha,
	gitTreeSha,
	loadSiteContent,
	parseStaticSiteTree,
	readSiteBlob,
	type SiteBlob,
	type SiteContent,
	STATIC_SITE_MAX_FILE_BYTES,
	STATIC_SITE_MAX_FILES,
	STATIC_SITE_MAX_TOTAL_BYTES,
	STATIC_SITE_TREE_CONTRACT,
	type StaticSiteFile,
	type StaticSiteTree,
} from "./site-tree.js";
export {
	GITHUB_PAGES_TRAFFIC_ROUTING_ABSENT,
	GITHUB_PAGES_TRAFFIC_ROUTING_OFFERING_IDS,
	GITHUB_PAGES_TRAFFIC_ROUTING_PROFILE,
} from "./traffic-routing-offerings.js";

// public-contract: package identity used by generated catalogs.
export const HOBO_PROVIDER_GITHUB_PACKAGE = "@hobo/provider-github";
