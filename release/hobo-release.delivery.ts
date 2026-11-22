/** public-contract: HoBo release train delivery-as-code. */

const repository = process.env.GITHUB_REPOSITORY?.trim() || "Hobo-Labs/HoBo";

const RELEASE_YARD = "hobo-release";
const RELEASE_FAMILIES = ["npm", "oci", "pages"] as const;
const RELEASE_CHANNELS = ["candidate", "stable"] as const;

export const PAGES_RELEASE_BUILD_MARGIN_MS = 540_000;
const PAGES_RELEASE_VERIFICATION_WINDOW_MS = 300_000;
const PAGES_RELEASE_VERIFICATION_PROGRESS_MS =
	PAGES_RELEASE_BUILD_MARGIN_MS + PAGES_RELEASE_VERIFICATION_WINDOW_MS;

type Family = (typeof RELEASE_FAMILIES)[number];
type Channel = (typeof RELEASE_CHANNELS)[number];

const PROVIDER = {
	npm: "@hobo/provider-npm",
	oci: "@hobo/provider-oci-registry",
	pages: "@hobo/provider-github",
} as const satisfies Record<Family, string>;

const YARD = {
	npm: "hobo-release-npm",
	oci: "hobo-release-oci",
	pages: "hobo-release-pages",
} as const satisfies Record<Family, string>;

// Where each family publishes. Shared by both channels: candidate realizes the
// release on the target, stable re-observes the same Freight there and
// qualifies it (promote, never rebuild).
const BINDING = {
	// npmjs with the hobodev automation token and provenance required: the
	// release job signs each tarball's Sigstore bundle and records it in the
	// Freight (scripts/ci/publish-npm-sdk.mts); the realizer attaches it to the
	// publish. Token auth, because npm's OIDC exchange routes only for the
	// escaped scope separator, which the transport guard refuses.
	npm: {
		"hobo.cd/npm.registry": "npmjs",
		"hobo.cd/npm.auth": "token",
		"hobo.cd/npm.provenance": "required",
		"hobo.cd/credential-ref": "env://NPM_TOKEN",
	},
	// GHCR with the workflow's GITHUB_TOKEN (packages: write).
	oci: {
		"hobo.cd/oci.registry": "ghcr.io",
		"hobo.cd/oci.auth-realm": "https://ghcr.io/token",
		"hobo.cd/oci.username": "hobo-release",
		"hobo.cd/credential-ref": "env://GITHUB_TOKEN",
	},
	// The Pages site of this repository, built from gh-pages (contents: write).
	pages: {
		"hobo.cd/github.repository": repository,
		"hobo.cd/github.pages.branch": "gh-pages",
		"hobo.cd/github.pages.path": "/",
		"hobo.cd/credential-ref": "env://GITHUB_TOKEN",
	},
} as const satisfies Record<Family, Readonly<Record<string, string>>>;

// Per-channel binding overrides. The npm stable Camp only re-reads a public
// package (`observe`), so it binds anonymous reads and resolves no credential:
// the job that promotes stable never holds the npm token.
const NPM_STABLE_BINDING = {
	"hobo.cd/npm.auth": "anonymous",
	"hobo.cd/credential-ref": "none://npm-public-read",
} as const;

function channelBinding(family: Family, channel: Channel) {
	return family === "npm" && channel === "stable"
		? NPM_STABLE_BINDING
		: undefined;
}

// What each channel's Camp may do at the target. Candidate writes the release
// there; stable only re-reads it (`observe`: resolver read, pull-only token
// scope), so the stable jobs, which hold no `packages: write`, never ask a
// registry for push scope.
const MODE = {
	candidate: "converge",
	stable: "observe",
} as const satisfies Record<Channel, "converge" | "observe">;

// Verification per family: one HTTP probe of the published target, failing
// closed on no data. The content proof is the realizer's own observation (the
// resolver re-reads the digest, tag, dist-tag or branch tree before it reports
// CONVERGED, I5); the probe is the Camp's health evidence, a fixed URL per
// family (a record cannot name a per-release URL):
// - npm: the registry answers its ping;
// - oci: GHCR answers the distribution API (an anonymous request is
//   challenged with 401: the registry is up and speaking v2);
const [owner, repo] = repository.split("/");
const PROBE = {
	npm: { url: "https://registry.npmjs.org/-/ping", status: 200 },
	oci: { url: "https://ghcr.io/v2/", status: 401 },
	pages: {
		url: `https://api.github.com/repos/${owner}/${repo}/pages/builds/latest`,
		status: 200,
	},
} as const satisfies Record<Family, Readonly<{ url: string; status: number }>>;

function verification(family: Family) {
	return {
		windowMs:
			family === "pages"
				? String(PAGES_RELEASE_VERIFICATION_WINDOW_MS)
				: "10000",
		requiredObservations: 2,
		progressDeadlineMs:
			family === "pages"
				? String(PAGES_RELEASE_VERIFICATION_PROGRESS_MS)
				: "300000",
		failOnNoData: true,
		probes: [
			{
				name: `${family}-target`,
				urlRef: PROBE[family].url,
				expectStatus: PROBE[family].status,
				intervalMs: family === "pages" ? "10000" : "5000",
				minSuccessRatio: 1,
			},
		],
	};
}

/** `<yard>/<family>-<channel>`: the Camp a family's channel promotes into. */
function releaseCampId(family: Family, channel: Channel): string {
	return `${RELEASE_YARD}/${family}-${channel}`;
}

// An empty stationId is the Station the CD runtime composes (HOBO_STATION).
export const camps = RELEASE_FAMILIES.flatMap((family) =>
	RELEASE_CHANNELS.map((channel) => ({
		campId: `${YARD[family]}/${family}-${channel}`,
		logicalId: releaseCampId(family, channel),
		yardId: YARD[family],
		provider: PROVIDER[family],
		envType: channel,
		labels: {
			"hobo.release/family": family,
			"hobo.release/channel": channel,
			...BINDING[family],
			...channelBinding(family, channel),
			"hobo.cd/realize-mode": MODE[channel],
		},
	})),
);

// One pipeline per family: stable takes only Freight candidate qualified.
export const pipelines = RELEASE_FAMILIES.map((family) => ({
	name: `hobo-release-${family}`,
	bindle: `hobo-release-${family}`,
	nodes: [
		{
			name: "candidate",
			campIds: [releaseCampId(family, "candidate")],
			fromSources: ["origin:manifest"],
			// A registry or a branch carries no traffic to shift: all at once.
			strategy: "ROLLOUT_STRATEGY_ALL_AT_ONCE",
			verification: verification(family),
		},
		{
			name: "stable",
			campIds: [releaseCampId(family, "stable")],
			fromNodes: ["candidate"],
			strategy: "ROLLOUT_STRATEGY_ALL_AT_ONCE",
			verification: verification(family),
		},
	],
}));
