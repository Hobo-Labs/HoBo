// HoBo's own release train as delivery-as-code (plan 0024; docs/design/release-channels.md).
//
// One Yard, `hobo-release`, with a candidate and a stable Camp per artifact
// family. Every CD command reads it as topology:
//   hobo deploy camp list --yard release/hobo-release.delivery.ts
//   hobo deploy pipeline apply --file release/hobo-release.delivery.ts
// Each Camp is realized by the catalogued resolver of its provider
// (packages/hobo/src/provider-hosting-catalog.ts, "Resolver realizers"). The
// labels bind where a Camp publishes and which credential locator it may use;
// what it publishes (artifacts by digest, tags, dist-tag, commit message) is
// the Freight's. Locators are names, never values: `env://GITHUB_TOKEN` is the
// workflow's token, resolved at call time by the CD host and never recorded.
//
// The repository defaults to Hobo-Labs/HoBo; GITHUB_REPOSITORY (set on every
// Actions run) names it on a fork, so Pages and GHCR follow the repository the
// workflow runs in, exactly as the workflow steps they replace did.

const repository = process.env.GITHUB_REPOSITORY?.trim() || "Hobo-Labs/HoBo";

const RELEASE_YARD = "hobo-release";
const RELEASE_FAMILIES = ["npm", "oci", "pages"] as const;
const RELEASE_CHANNELS = ["candidate", "stable"] as const;

type Family = (typeof RELEASE_FAMILIES)[number];
type Channel = (typeof RELEASE_CHANNELS)[number];

const PROVIDER: Record<Family, string> = {
	npm: "@hobo/provider-npm",
	oci: "@hobo/provider-oci-registry",
	pages: "@hobo/provider-github",
};

// Where each family publishes. Shared by both channels: candidate realizes the
// release on the target, stable re-observes the same Freight there and
// qualifies it (promote, never rebuild).
const BINDING: Record<Family, Record<string, string>> = {
	// npm trusted publishing with provenance, as release-npm runs it today.
	// @hobo/provider-npm refuses both (scoped OIDC exchange; no Sigstore
	// bundle in the Freight): a typed refusal, so `npm publish --provenance`
	// stays the npm publisher (live-provider-matrix.md).
	npm: {
		"hobo.cd/npm.registry": "npmjs",
		"hobo.cd/npm.auth": "oidc-trusted-publishing",
		"hobo.cd/npm.provenance": "required",
		"hobo.cd/credential-ref": "env://NPM_ID_TOKEN",
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
};

// Verification per family: one HTTP probe of the published target, failing
// closed on no data. The content proof is the realizer's own observation (the
// resolver re-reads the digest, tag, dist-tag or branch tree before it reports
// CONVERGED, I5); the probe is the Camp's health evidence, a fixed URL per
// family (a record cannot name a per-release URL):
// - npm: the registry answers its ping;
// - oci: GHCR answers the distribution API (an anonymous request is
//   challenged with 401: the registry is up and speaking v2);
// - pages: the gh-pages branch serves the site entry (raw, public repo).
const [owner, repo] = repository.split("/");
const PROBE: Record<Family, { url: string; status: number }> = {
	npm: { url: "https://registry.npmjs.org/-/ping", status: 200 },
	oci: { url: "https://ghcr.io/v2/", status: 401 },
	pages: {
		url: `https://raw.githubusercontent.com/${owner}/${repo}/gh-pages/index.html`,
		status: 200,
	},
};

function verification(family: Family) {
	return {
		windowMs: "10000",
		requiredObservations: 2,
		progressDeadlineMs: "300000",
		failOnNoData: true,
		probes: [
			{
				name: `${family}-target`,
				urlRef: PROBE[family].url,
				expectStatus: PROBE[family].status,
				intervalMs: "5000",
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
		campId: releaseCampId(family, channel),
		yardId: RELEASE_YARD,
		provider: PROVIDER[family],
		envType: channel,
		labels: {
			"hobo.release/family": family,
			"hobo.release/channel": channel,
			...BINDING[family],
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
