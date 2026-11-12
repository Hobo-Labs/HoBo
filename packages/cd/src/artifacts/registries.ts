// "Registry digest at coordinate" for each ecosystem the hobo:artifact-repo
// port registers (npm, NuGet, PyPI, OCI, Maven, Cargo, RubyGems). Each lookup
// reads only the registry's own published digest for exactly the pinned
// version — never a tag, a "latest", or a payload the caller supplied — and
// fails closed on anything it cannot read.
import type { HttpTransport } from "@hobo/core";
import type { ArtifactRef, ReasonRecord } from "../_generated/cd_pb.js";
import {
	httpsBase,
	type OciReference,
	type Purl,
	parseOciReference,
	parsePurl,
	registryHost,
	sameHttpsHost,
} from "./coordinates.js";
import { sha256Digest } from "./digest.js";
import {
	isJsonArray,
	isJsonObject,
	type JsonObject,
	type JsonValue,
	parseJsonText,
	stringAt,
} from "./json.js";
import { ARTIFACT_REASON, reason } from "./reasons.js";

/** A digest the registry publishes; sha256 compares directly, others need the bytes. */
export type RegistryDigest = Readonly<{
	algorithm: "sha1" | "sha256" | "sha512";
	/** Lowercase hex. */
	hex: string;
	/** Where the registry published it, for messages (never a credential). */
	source: string;
}>;

export type LookupResult =
	| Readonly<{ ok: true; digests: readonly RegistryDigest[] }>
	| Readonly<{ ok: false; reason: ReasonRecord }>;

// public-contract: default registry endpoints per ecosystem; a purl
// `repository_url` qualifier overrides them (https only).
export const DEFAULT_REGISTRIES = Object.freeze({
	npm: "https://registry.npmjs.org",
	pypi: "https://pypi.org",
	nuget: "https://api.nuget.org/v3/registration5-semver1",
	maven: "https://repo.maven.apache.org/maven2",
	cargo: "https://index.crates.io",
	rubygems: "https://rubygems.org",
} as const);

// public-contract: ecosystems whose registry digest the verifier can read.
export const REGISTRY_ECOSYSTEMS = Object.freeze([
	"oci",
	"npm",
	"nuget",
	"pypi",
	"maven",
	"cargo",
	"rubygems",
] as const);
export type RegistryEcosystem = (typeof REGISTRY_ECOSYSTEMS)[number];

const PURL_TYPE = {
	npm: "npm",
	pypi: "pypi",
	nuget: "nuget",
	maven: "maven",
	cargo: "cargo",
	rubygems: "gem",
} as const satisfies Readonly<
	Record<Exclude<RegistryEcosystem, "oci">, string>
>;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 1_048_576;
const OCI_ACCEPT = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.oci.artifact.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

type Fetched =
	| Readonly<{
			ok: true;
			status: number;
			headers: Readonly<Record<string, string>>;
			body: string;
	  }>
	| Readonly<{ ok: false; reason: ReasonRecord }>;

function fail(
	code: Parameters<typeof reason>[0],
	message: string,
	remediation: string,
	subject: string,
): LookupResult {
	return { ok: false, reason: reason(code, message, remediation, subject) };
}

function unavailable(subject: string, what: string): ReasonRecord {
	return reason(
		ARTIFACT_REASON.registryUnavailable,
		`${what} could not be read`,
		"Retry when the registry is reachable from the CD service, or put the artifact in the HoBo artifact store and reference it with ecosystem `store`.",
		subject,
	);
}

async function get(
	http: HttpTransport,
	url: string,
	subject: string,
	headers: Readonly<Record<string, string>> = { accept: "application/json" },
): Promise<Fetched> {
	try {
		const response = await http({
			method: "GET",
			url,
			headers,
			timeoutMs: REQUEST_TIMEOUT_MS,
			maxResponseBytes: MAX_RESPONSE_BYTES,
		});
		return {
			ok: true,
			status: response.status,
			headers: response.headers,
			body: response.body,
		};
	} catch {
		return { ok: false, reason: unavailable(subject, new URL(url).host) };
	}
}

/** GET JSON; 404 → not found, other non-2xx → unavailable, bad JSON → malformed. */
async function getJson(
	http: HttpTransport,
	url: string,
	subject: string,
	notFound: string,
): Promise<
	| Readonly<{ ok: true; value: JsonValue }>
	| Readonly<{ ok: false; reason: ReasonRecord }>
> {
	const fetched = await get(http, url, subject);
	if (!fetched.ok) return fetched;
	if (fetched.status === 404)
		return {
			ok: false,
			reason: reason(
				ARTIFACT_REASON.registryNotFound,
				notFound,
				"Check the coordinate's name and pinned version; a version that was never published (or was removed) cannot back Freight.",
				subject,
			),
		};
	if (fetched.status < 200 || fetched.status > 299)
		return {
			ok: false,
			reason: unavailable(
				subject,
				`${new URL(url).host} (HTTP ${fetched.status})`,
			),
		};
	const value = parseJsonText(fetched.body);
	if (value === undefined)
		return { ok: false, reason: malformed(subject, new URL(url).host) };
	return { ok: true, value };
}

function malformed(subject: string, host: string): ReasonRecord {
	return reason(
		ARTIFACT_REASON.registryMalformed,
		`${host} answered with a document the verifier cannot read`,
		"Point the coordinate at a registry that speaks the ecosystem's standard API, or store the artifact in the HoBo artifact store.",
		subject,
	);
}

function base(
	purl: Purl,
	ecosystem: Exclude<RegistryEcosystem, "oci">,
): string | undefined {
	const override = purl.qualifiers.repository_url;
	return override === undefined
		? DEFAULT_REGISTRIES[ecosystem]
		: httpsBase(override);
}

function base64ToHex(value: string): string | undefined {
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
	return Buffer.from(value, "base64").toString("hex");
}

function pinnedPurl(
	artifact: ArtifactRef,
	ecosystem: Exclude<RegistryEcosystem, "oci">,
):
	| Readonly<{ ok: true; purl: Purl; base: string }>
	| Readonly<{ ok: false; result: LookupResult }> {
	const purl = parsePurl(artifact.coordinate);
	if (purl === undefined || purl.type !== PURL_TYPE[ecosystem])
		return {
			ok: false,
			result: fail(
				ARTIFACT_REASON.coordinateInvalid,
				`${ecosystem} coordinate must be a pkg:${PURL_TYPE[ecosystem]}/… package URL`,
				`Write the coordinate as pkg:${PURL_TYPE[ecosystem]}/<name>@<version>.`,
				artifact.name,
			),
		};
	if (purl.version === "")
		return {
			ok: false,
			result: fail(
				ARTIFACT_REASON.coordinateMutable,
				`${ecosystem} coordinate names no version, so it does not pin one artifact`,
				"Pin the exact published version in the coordinate (pkg:<type>/<name>@<version>).",
				artifact.name,
			),
		};
	const root = base(purl, ecosystem);
	if (root === undefined)
		return {
			ok: false,
			result: fail(
				ARTIFACT_REASON.coordinateInvalid,
				"repository_url must be an https URL without credentials, query or fragment",
				"Use an https registry URL; credentials never belong in a coordinate.",
				artifact.name,
			),
		};
	return { ok: true, purl, base: root };
}

async function npm(
	http: HttpTransport,
	artifact: ArtifactRef,
): Promise<LookupResult> {
	const pinned = pinnedPurl(artifact, "npm");
	if (!pinned.ok) return pinned.result;
	const { purl } = pinned;
	const fullName =
		purl.namespace === "" ? purl.name : `${purl.namespace}/${purl.name}`;
	const path = fullName.startsWith("@")
		? `@${encodeURIComponent(fullName.slice(1))}`
		: encodeURIComponent(fullName);
	const url = `${pinned.base}/${path}/${encodeURIComponent(purl.version)}`;
	const fetched = await getJson(
		http,
		url,
		artifact.name,
		`npm has no ${fullName}@${purl.version}`,
	);
	if (!fetched.ok) return fetched;
	const dist = isJsonObject(fetched.value) ? fetched.value.dist : undefined;
	if (!isJsonObject(dist))
		return { ok: false, reason: malformed(artifact.name, new URL(url).host) };
	const digests: RegistryDigest[] = [];
	for (const entry of (stringAt(dist, "integrity") ?? "").split(/\s+/)) {
		const dash = entry.indexOf("-");
		if (dash <= 0) continue;
		const algorithm = entry.slice(0, dash);
		const hex = base64ToHex(entry.slice(dash + 1).split("?")[0] ?? "");
		if (hex === undefined) continue;
		if (algorithm === "sha256" || algorithm === "sha512")
			digests.push({ algorithm, hex, source: "npm dist.integrity" });
	}
	const shasum = stringAt(dist, "shasum");
	if (
		digests.length === 0 &&
		shasum !== undefined &&
		/^[0-9a-f]{40}$/.test(shasum)
	)
		digests.push({ algorithm: "sha1", hex: shasum, source: "npm dist.shasum" });
	return digests.length === 0
		? { ok: false, reason: malformed(artifact.name, new URL(url).host) }
		: { ok: true, digests };
}

async function pypi(
	http: HttpTransport,
	artifact: ArtifactRef,
): Promise<LookupResult> {
	const pinned = pinnedPurl(artifact, "pypi");
	if (!pinned.ok) return pinned.result;
	const { purl } = pinned;
	const filename = purl.qualifiers.file_name ?? artifact.name;
	const url = `${pinned.base}/pypi/${encodeURIComponent(purl.name)}/${encodeURIComponent(purl.version)}/json`;
	const fetched = await getJson(
		http,
		url,
		artifact.name,
		`PyPI has no ${purl.name} ${purl.version}`,
	);
	if (!fetched.ok) return fetched;
	const files = isJsonObject(fetched.value) ? fetched.value.urls : undefined;
	if (!isJsonArray(files))
		return { ok: false, reason: malformed(artifact.name, new URL(url).host) };
	const file = files.find(
		(entry): entry is JsonObject =>
			isJsonObject(entry) && entry.filename === filename,
	);
	if (file === undefined)
		return fail(
			ARTIFACT_REASON.registryNotFound,
			`PyPI ${purl.name} ${purl.version} has no distribution file named ${filename}`,
			"Name the exact distribution file with the purl `file_name` qualifier (or the artifact name).",
			artifact.name,
		);
	const digests = file.digests;
	const sha256 = isJsonObject(digests)
		? stringAt(digests, "sha256")
		: undefined;
	return sha256 !== undefined && /^[0-9a-f]{64}$/.test(sha256)
		? {
				ok: true,
				digests: [
					{ algorithm: "sha256", hex: sha256, source: "PyPI digests.sha256" },
				],
			}
		: { ok: false, reason: malformed(artifact.name, new URL(url).host) };
}

async function nuget(
	http: HttpTransport,
	artifact: ArtifactRef,
): Promise<LookupResult> {
	const pinned = pinnedPurl(artifact, "nuget");
	if (!pinned.ok) return pinned.result;
	const { purl } = pinned;
	const leafUrl = `${pinned.base}/${encodeURIComponent(purl.name.toLowerCase())}/${encodeURIComponent(purl.version.toLowerCase())}.json`;
	const leaf = await getJson(
		http,
		leafUrl,
		artifact.name,
		`NuGet has no ${purl.name} ${purl.version}`,
	);
	if (!leaf.ok) return leaf;
	const host = new URL(leafUrl).host;
	const catalogUrl = isJsonObject(leaf.value)
		? stringAt(leaf.value, "catalogEntry")
		: undefined;
	// The catalog entry must live on the registration host: a registration that
	// points elsewhere is not trusted to name the hash.
	if (catalogUrl === undefined || !sameHttpsHost(catalogUrl, host))
		return { ok: false, reason: malformed(artifact.name, host) };
	const catalog = await getJson(
		http,
		catalogUrl,
		artifact.name,
		`NuGet catalog entry for ${purl.name} ${purl.version} is missing`,
	);
	if (!catalog.ok) return catalog;
	if (!isJsonObject(catalog.value))
		return { ok: false, reason: malformed(artifact.name, host) };
	const algorithm = (
		stringAt(catalog.value, "packageHashAlgorithm") ?? ""
	).toLowerCase();
	const hex = base64ToHex(stringAt(catalog.value, "packageHash") ?? "");
	if ((algorithm !== "sha512" && algorithm !== "sha256") || hex === undefined)
		return { ok: false, reason: malformed(artifact.name, host) };
	return {
		ok: true,
		digests: [{ algorithm, hex, source: "NuGet catalog packageHash" }],
	};
}

async function maven(
	http: HttpTransport,
	artifact: ArtifactRef,
): Promise<LookupResult> {
	const pinned = pinnedPurl(artifact, "maven");
	if (!pinned.ok) return pinned.result;
	const { purl } = pinned;
	if (purl.namespace === "")
		return fail(
			ARTIFACT_REASON.coordinateInvalid,
			"maven coordinate needs a groupId namespace",
			"Write it as pkg:maven/<groupId>/<artifactId>@<version>[?type=jar&classifier=…].",
			artifact.name,
		);
	const type = purl.qualifiers.type ?? "jar";
	const classifier = purl.qualifiers.classifier;
	const file = `${purl.name}-${purl.version}${classifier === undefined ? "" : `-${classifier}`}.${type}`;
	const directory = [...purl.namespace.split(/[./]/), purl.name, purl.version]
		.map(encodeURIComponent)
		.join("/");
	const fileUrl = `${pinned.base}/${directory}/${encodeURIComponent(file)}`;
	for (const [algorithm, length] of [
		["sha256", 64],
		["sha1", 40],
	] as const) {
		const fetched = await get(http, `${fileUrl}.${algorithm}`, artifact.name, {
			accept: "text/plain",
		});
		if (!fetched.ok) return { ok: false, reason: fetched.reason };
		if (fetched.status === 404) continue;
		if (fetched.status < 200 || fetched.status > 299)
			return {
				ok: false,
				reason: unavailable(
					artifact.name,
					`${new URL(fileUrl).host} (HTTP ${fetched.status})`,
				),
			};
		const hex = fetched.body.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
		if (hex.length !== length || !/^[0-9a-f]+$/.test(hex))
			return {
				ok: false,
				reason: malformed(artifact.name, new URL(fileUrl).host),
			};
		return {
			ok: true,
			digests: [{ algorithm, hex, source: `Maven .${algorithm}` }],
		};
	}
	return fail(
		ARTIFACT_REASON.registryNotFound,
		`Maven repository publishes no .sha256 or .sha1 for ${file}`,
		"Check the groupId, artifactId, version, type and classifier; the repository must publish a checksum beside the file.",
		artifact.name,
	);
}

export function cratesIndexPath(name: string): string {
	const lower = name.toLowerCase();
	if (lower.length === 1) return `1/${lower}`;
	if (lower.length === 2) return `2/${lower}`;
	if (lower.length === 3) return `3/${lower.slice(0, 1)}/${lower}`;
	return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

async function cargo(
	http: HttpTransport,
	artifact: ArtifactRef,
): Promise<LookupResult> {
	const pinned = pinnedPurl(artifact, "cargo");
	if (!pinned.ok) return pinned.result;
	const { purl } = pinned;
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(purl.name))
		return fail(
			ARTIFACT_REASON.coordinateInvalid,
			"crate name is not a valid crates.io name",
			"Use the crate's registry name.",
			artifact.name,
		);
	const url = `${pinned.base}/${cratesIndexPath(purl.name)}`;
	const fetched = await get(http, url, artifact.name, { accept: "text/plain" });
	if (!fetched.ok) return fetched;
	if (fetched.status === 404)
		return fail(
			ARTIFACT_REASON.registryNotFound,
			`crates index has no crate ${purl.name}`,
			"Check the crate name.",
			artifact.name,
		);
	if (fetched.status < 200 || fetched.status > 299)
		return {
			ok: false,
			reason: unavailable(
				artifact.name,
				`${new URL(url).host} (HTTP ${fetched.status})`,
			),
		};
	for (const line of fetched.body.split("\n")) {
		const entry = parseJsonText(line);
		if (!isJsonObject(entry) || entry.vers !== purl.version) continue;
		const cksum = stringAt(entry, "cksum");
		return cksum !== undefined && /^[0-9a-f]{64}$/.test(cksum)
			? {
					ok: true,
					digests: [
						{ algorithm: "sha256", hex: cksum, source: "crates index cksum" },
					],
				}
			: { ok: false, reason: malformed(artifact.name, new URL(url).host) };
	}
	return fail(
		ARTIFACT_REASON.registryNotFound,
		`crates index has no ${purl.name} ${purl.version}`,
		"Check the pinned version; it must be published in the index.",
		artifact.name,
	);
}

async function rubygems(
	http: HttpTransport,
	artifact: ArtifactRef,
): Promise<LookupResult> {
	const pinned = pinnedPurl(artifact, "rubygems");
	if (!pinned.ok) return pinned.result;
	const { purl } = pinned;
	const platform = purl.qualifiers.platform;
	const url = `${pinned.base}/api/v2/rubygems/${encodeURIComponent(purl.name)}/versions/${encodeURIComponent(purl.version)}.json${platform === undefined ? "" : `?platform=${encodeURIComponent(platform)}`}`;
	const fetched = await getJson(
		http,
		url,
		artifact.name,
		`RubyGems has no ${purl.name} ${purl.version}`,
	);
	if (!fetched.ok) return fetched;
	const sha = isJsonObject(fetched.value)
		? stringAt(fetched.value, "sha")
		: undefined;
	return sha !== undefined && /^[0-9a-f]{64}$/.test(sha)
		? {
				ok: true,
				digests: [{ algorithm: "sha256", hex: sha, source: "RubyGems sha" }],
			}
		: { ok: false, reason: malformed(artifact.name, new URL(url).host) };
}

function challenge(
	header: string | undefined,
): Readonly<Record<string, string>> | undefined {
	if (header === undefined || !/^Bearer\s/i.test(header)) return undefined;
	const params: Record<string, string> = {};
	for (const match of header.slice(7).matchAll(/([a-zA-Z]+)="([^"]*)"/g))
		if (match[1] !== undefined && match[2] !== undefined)
			params[match[1].toLowerCase()] = match[2];
	return params;
}

async function anonymousToken(
	http: HttpTransport,
	reference: OciReference,
	header: string | undefined,
	subject: string,
): Promise<string | undefined> {
	const params = challenge(header);
	const realm = params?.realm;
	if (
		params === undefined ||
		realm === undefined ||
		httpsBase(realm) === undefined
	)
		return undefined;
	const query = new URLSearchParams();
	if (params.service !== undefined) query.set("service", params.service);
	query.set("scope", params.scope ?? `repository:${reference.repository}:pull`);
	const fetched = await get(http, `${realm}?${query.toString()}`, subject);
	if (!fetched.ok || fetched.status !== 200) return undefined;
	const body = parseJsonText(fetched.body);
	if (!isJsonObject(body)) return undefined;
	const token = stringAt(body, "token") ?? stringAt(body, "access_token");
	return token !== undefined && token !== "" ? token : undefined;
}

async function oci(
	http: HttpTransport,
	artifact: ArtifactRef,
): Promise<LookupResult> {
	const reference = parseOciReference(artifact.coordinate);
	if (reference === undefined)
		return fail(
			ARTIFACT_REASON.coordinateInvalid,
			"OCI coordinate must be host/repository[:tag]@sha256:<hex>",
			"Write the image as a digest reference, e.g. ghcr.io/acme/api@sha256:…",
			artifact.name,
		);
	if (reference.digest === "")
		return fail(
			ARTIFACT_REASON.coordinateMutable,
			"OCI coordinate is a tag without a digest, which can move",
			"Pin the manifest digest in the coordinate (…@sha256:<hex>); tags alone never back Freight.",
			artifact.name,
		);
	const host = registryHost(reference);
	const url = `https://${host}/v2/${reference.repository}/manifests/${reference.digest}`;
	let fetched = await get(http, url, artifact.name, { accept: OCI_ACCEPT });
	if (fetched.ok && fetched.status === 401) {
		const token = await anonymousToken(
			http,
			reference,
			fetched.headers["www-authenticate"],
			artifact.name,
		);
		if (token !== undefined)
			fetched = await get(http, url, artifact.name, {
				accept: OCI_ACCEPT,
				authorization: `Bearer ${token}`,
			});
	}
	if (!fetched.ok) return fetched;
	if (fetched.status === 404)
		return fail(
			ARTIFACT_REASON.registryNotFound,
			`${host} has no manifest ${reference.digest} in ${reference.repository}`,
			"Push the image (or mirror it) so the pinned manifest digest exists in the registry.",
			artifact.name,
		);
	if (fetched.status === 401 || fetched.status === 403)
		return fail(
			ARTIFACT_REASON.registryUnavailable,
			`${host} refused an anonymous pull of ${reference.repository} (HTTP ${fetched.status})`,
			"Allow anonymous pull for the repository, or put the image in the HoBo artifact store and reference it with ecosystem `store`.",
			artifact.name,
		);
	if (fetched.status < 200 || fetched.status > 299)
		return {
			ok: false,
			reason: unavailable(artifact.name, `${host} (HTTP ${fetched.status})`),
		};
	const computed = sha256Digest(new TextEncoder().encode(fetched.body));
	const advertised = fetched.headers["docker-content-digest"];
	if (advertised !== undefined && advertised !== computed)
		return fail(
			ARTIFACT_REASON.digestMismatch,
			`${host} advertised ${advertised} but served a manifest hashing to ${computed}`,
			"Do not promote this artifact; the registry or a proxy is serving inconsistent content.",
			artifact.name,
		);
	return {
		ok: true,
		digests: [
			{
				algorithm: "sha256",
				hex: computed.slice(7),
				source: "OCI manifest digest",
			},
			{
				algorithm: "sha256",
				hex: reference.digest.slice(7),
				source: "OCI coordinate digest",
			},
		],
	};
}

const LOOKUPS = {
	oci,
	npm,
	nuget,
	pypi,
	maven,
	cargo,
	rubygems,
} as const satisfies Readonly<
	Record<
		RegistryEcosystem,
		(http: HttpTransport, artifact: ArtifactRef) => Promise<LookupResult>
	>
>;

export function isRegistryEcosystem(value: string): value is RegistryEcosystem {
	return REGISTRY_ECOSYSTEMS.some((ecosystem) => ecosystem === value);
}

export function lookupRegistryDigest(
	http: HttpTransport,
	ecosystem: RegistryEcosystem,
	artifact: ArtifactRef,
): Promise<LookupResult> {
	return LOOKUPS[ecosystem](http, artifact);
}
