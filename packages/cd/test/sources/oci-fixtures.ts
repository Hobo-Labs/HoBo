// Recorded OCI distribution exchanges (registry.example.com/team/app): a
// bearer-token challenge, two pages of tags, HEAD digests, manifests with a
// revision annotation, and a Sigstore-bundle referrer for one image.
import { digestOf, type Exchange, json } from "./support.js";

export const OCI_HOST = "registry.example.com";
export const OCI_REPO = "team/app";
export const OCI_BASE = `https://${OCI_HOST}/v2/${OCI_REPO}`;
export const TOKEN_URL =
	"https://auth.example.com/token?service=registry.example.com&scope=repository%3Ateam%2Fapp%3Apull";
export const AUTH = { authorization: "Bearer reg-token" };
export const COMMIT_A = "a".repeat(40);
export const COMMIT_B = "b".repeat(40);

export function imageManifest(
	tag: string,
	revision: string,
	created: string,
): string {
	return json({
		schemaVersion: 2,
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		config: {
			mediaType: "application/vnd.oci.image.config.v1+json",
			digest: digestOf(`config-${tag}`),
			size: 2,
		},
		layers: [],
		annotations: {
			"org.opencontainers.image.revision": revision,
			"org.opencontainers.image.created": created,
		},
	});
}

export const MANIFESTS = {
	"1.0.0": imageManifest("1.0.0", COMMIT_A, "2026-11-01T00:00:00Z"),
	"1.1.0": imageManifest("1.1.0", COMMIT_A, "2026-11-02T00:00:00Z"),
	"1.2.0": imageManifest("1.2.0", COMMIT_B, "2026-11-03T00:00:00Z"),
} as const;

export const DIGESTS = {
	"1.0.0": digestOf(MANIFESTS["1.0.0"]),
	"1.1.0": digestOf(MANIFESTS["1.1.0"]),
	"1.2.0": digestOf(MANIFESTS["1.2.0"]),
} as const;

/** A statement the FakeProvenance verifier accepts for `subject`. */
export function statementFor(
	subject: string,
	builder = "https://ci.example/builder",
): string {
	return json({
		builder,
		subjects: [subject],
		signer: "https://ci.example/signer",
	});
}

export const BUNDLE_120 = json({
	mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
	dsseEnvelope: {
		payloadType: "application/vnd.in-toto+json",
		payload: Buffer.from(statementFor(DIGESTS["1.2.0"])).toString("base64"),
		signatures: [{ sig: "c2ln" }],
	},
});
export const REFERRER_MANIFEST = json({
	schemaVersion: 2,
	mediaType: "application/vnd.oci.image.manifest.v1+json",
	artifactType: "application/vnd.dev.sigstore.bundle.v0.3+json",
	config: {
		mediaType: "application/vnd.oci.empty.v1+json",
		digest: digestOf("{}"),
		size: 2,
	},
	layers: [
		{
			mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
			digest: digestOf(BUNDLE_120),
			size: BUNDLE_120.length,
		},
	],
	subject: {
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		digest: DIGESTS["1.2.0"],
		size: 1,
	},
});

function manifestExchanges(tag: keyof typeof MANIFESTS): Exchange[] {
	return [
		{
			method: "HEAD",
			url: `${OCI_BASE}/manifests/${tag}`,
			headers: AUTH,
			responseHeaders: { "Docker-Content-Digest": DIGESTS[tag] },
		},
		{
			url: `${OCI_BASE}/manifests/${DIGESTS[tag]}`,
			headers: AUTH,
			response: MANIFESTS[tag],
		},
		{
			url: `${OCI_BASE}/manifests/${tag}`,
			headers: AUTH,
			responseHeaders: { "Docker-Content-Digest": DIGESTS[tag] },
			response: MANIFESTS[tag],
		},
	];
}

export const OCI_FIXTURES: readonly Exchange[] = [
	{ url: TOKEN_URL, response: json({ token: "reg-token", expires_in: 300 }) },
	{
		url: `${OCI_BASE}/tags/list?n=1000`,
		headers: AUTH,
		responseHeaders: {
			Link: `</v2/${OCI_REPO}/tags/list?n=1000&last=1.1.0>; rel="next"`,
		},
		response: json({ name: OCI_REPO, tags: ["1.0.0", "latest", "1.1.0"] }),
	},
	{
		url: `${OCI_BASE}/tags/list?n=1000&last=1.1.0`,
		headers: AUTH,
		response: json({ name: OCI_REPO, tags: ["1.2.0", "1.2.0-rc.1"] }),
	},
	{
		url: `${OCI_BASE}/tags/list?n=1000`,
		status: 401,
		responseHeaders: {
			"WWW-Authenticate":
				'Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:team/app:pull"',
		},
	},
	{ url: `${OCI_BASE}/manifests/1.2.0-rc.1`, headers: AUTH, status: 404 },
	...manifestExchanges("1.0.0"),
	...manifestExchanges("1.1.0"),
	...manifestExchanges("1.2.0"),
	{
		url: `${OCI_BASE}/referrers/${DIGESTS["1.2.0"]}`,
		headers: AUTH,
		response: json({
			schemaVersion: 2,
			mediaType: "application/vnd.oci.image.index.v1+json",
			manifests: [
				{
					mediaType: "application/vnd.oci.image.manifest.v1+json",
					digest: digestOf(REFERRER_MANIFEST),
					size: 1,
					artifactType: "application/vnd.dev.sigstore.bundle.v0.3+json",
				},
				{
					mediaType: "application/vnd.oci.image.manifest.v1+json",
					digest: digestOf("sbom"),
					size: 1,
					artifactType: "application/spdx+json",
				},
			],
		}),
	},
	{
		url: `${OCI_BASE}/manifests/${digestOf(REFERRER_MANIFEST)}`,
		headers: AUTH,
		response: REFERRER_MANIFEST,
	},
	{
		url: `${OCI_BASE}/blobs/${digestOf(BUNDLE_120)}`,
		headers: AUTH,
		response: BUNDLE_120,
	},
	{
		url: `${OCI_BASE}/referrers/${DIGESTS["1.1.0"]}`,
		headers: AUTH,
		status: 404,
	},
	{
		url: `${OCI_BASE}/manifests/${DIGESTS["1.1.0"].replace(":", "-")}`,
		headers: AUTH,
		status: 404,
	},
	{
		url: `${OCI_BASE}/referrers/${DIGESTS["1.0.0"]}`,
		headers: AUTH,
		response: json({ schemaVersion: 2, manifests: [] }),
	},
];
