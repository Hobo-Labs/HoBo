// PACKAGE_REGISTRY subscriptions through the `hobo:artifact-repo` ecosystems
// (npm, PyPI, Maven, NuGet, crates, RubyGems). Versions come from each
// registry's own metadata API. The digest is always sha256 over the package
// bytes: taken from registry metadata where the registry publishes sha256
// (PyPI, crates, RubyGems, a Maven .sha256 sidecar), otherwise computed by
// reading the package (npm after its sha512 integrity check, NuGet, Maven).
//
// Locator: `<package>` on the public registry, or `<https base URL>|<package>`.
// Maven packages are `group:artifact[:extension]`.
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import type { HttpTransport, JsonValue } from "@hobo/core";
import {
	ArtifactKind,
	ArtifactRefSchema,
	SubscriptionKind,
	type SubscriptionRecord,
} from "../../_generated/cd_pb.js";
import type { CdContext, CredentialResolver, Outcome, SubscriptionDriver } from "../../ports.js";
import {
	bodyBytes,
	credentialHeaders,
	fetchSource,
	redactUrl,
	SOURCE_HTTP_MAX_ARTIFACT_BYTES,
	upstreamInvalid,
} from "../http.js";
import { field, isList, isRecord, isText, parseJson, sha256Hex, text } from "../json.js";
import { refuse, SOURCE_REASON } from "../reasons.js";
import { type Candidate, discovered, selectCandidates } from "./common.js";
import { safeHttpsUrl } from "./http-index.js";

// public-contract: package ecosystems a PACKAGE_REGISTRY subscription may name.
export const PACKAGE_ECOSYSTEMS = Object.freeze(["npm", "pypi", "maven", "nuget", "cargo", "rubygems"] as const);
export type PackageEcosystem = (typeof PACKAGE_ECOSYSTEMS)[number];

// public-contract: default public registry per ecosystem.
export const PACKAGE_REGISTRY_DEFAULTS: Readonly<Record<PackageEcosystem, string>> = Object.freeze({
	npm: "https://registry.npmjs.org",
	pypi: "https://pypi.org",
	maven: "https://repo1.maven.org/maven2",
	nuget: "https://api.nuget.org/v3-flatcontainer",
	cargo: "https://index.crates.io",
	rubygems: "https://rubygems.org",
});

const PURL_TYPE: Readonly<Record<PackageEcosystem, string>> = {
	npm: "npm",
	pypi: "pypi",
	maven: "maven",
	nuget: "nuget",
	cargo: "cargo",
	rubygems: "gem",
};

const HEX64 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9@._:/-]{1,214}$/;

type Resolved = Readonly<{ digest: string; mediaType: string }>;
type Listing = Readonly<{
	versions: readonly Readonly<{ version: string; resolve: () => Promise<Outcome<Resolved>> }>[];
}>;

type Locator = Readonly<{ ecosystem: PackageEcosystem; base: string; name: string }>;

function isEcosystem(value: string): value is PackageEcosystem {
	return PACKAGE_ECOSYSTEMS.some((item) => item === value);
}

export function parsePackageLocator(subscription: SubscriptionRecord): Outcome<Locator> {
	const ecosystem = subscription.ecosystem;
	if (!isEcosystem(ecosystem)) {
		return refuse(
			SOURCE_REASON.invalid,
			`ecosystem ${JSON.stringify(ecosystem)} is not a package registry`,
			`set ecosystem to one of ${PACKAGE_ECOSYSTEMS.join(", ")}`,
			`${subscription.name}.ecosystem`,
		);
	}
	const split = subscription.locator.split("|");
	const base = split.length === 2 ? (split[0] ?? "") : PACKAGE_REGISTRY_DEFAULTS[ecosystem];
	const name = split.length === 2 ? (split[1] ?? "") : subscription.locator;
	if (split.length > 2 || !safeHttpsUrl(base) || !NAME.test(name) || name.includes("..")) {
		return refuse(
			SOURCE_REASON.invalid,
			`locator ${JSON.stringify(subscription.locator)} is not <package> or <https base>|<package>`,
			"use the package name, or an https registry base URL (no credentials) and the package name joined by |",
			`${subscription.name}.locator`,
		);
	}
	if (ecosystem === "maven" && !/^[^:]+:[^:]+(:[A-Za-z0-9]+)?$/.test(name)) {
		return refuse(
			SOURCE_REASON.invalid,
			`maven locator ${name} is not group:artifact[:extension]`,
			"write the Maven coordinate as group:artifact or group:artifact:extension",
			`${subscription.name}.locator`,
		);
	}
	return { ok: true, value: { ecosystem, base: base.replace(/\/+$/, ""), name } };
}

export function packagePurl(ecosystem: PackageEcosystem, name: string, version: string): string {
	const type = PURL_TYPE[ecosystem];
	if (ecosystem === "maven") {
		const [group = "", artifact = ""] = name.split(":");
		return `pkg:maven/${group}/${artifact}@${encodeURIComponent(version)}`;
	}
	const normalized = ecosystem === "pypi" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name;
	const parts = normalized.split("/").map((part) => encodeURIComponent(part));
	return `pkg:${type}/${parts.join("/")}@${encodeURIComponent(version)}`;
}

export function cratesIndexPath(name: string): string {
	const lower = name.toLowerCase();
	if (lower.length <= 2) return `${lower.length}/${lower}`;
	if (lower.length === 3) return `3/${lower[0]}/${lower}`;
	return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}

type Fetcher = Readonly<{
	json: (url: string) => Promise<Outcome<JsonValue>>;
	textBody: (url: string, accept404?: boolean) => Promise<Outcome<string | undefined>>;
	hash: (url: string, check?: (bytes: Uint8Array) => boolean) => Promise<Outcome<Resolved>>;
}>;

function fetcher(http: HttpTransport, headers: Readonly<Record<string, string>>, ctx: CdContext): Fetcher {
	return {
		async json(url) {
			const response = await fetchSource(http, { url, headers: { ...headers, accept: "application/json" } }, ctx.now());
			if (!response.ok) return response;
			const value = parseJson(response.value.body);
			return value === undefined ? upstreamInvalid(redactUrl(url), "response is not JSON") : { ok: true, value };
		},
		async textBody(url, accept404 = false) {
			const response = await fetchSource(
				http,
				{ url, headers: { ...headers, accept: "text/plain, application/xml" }, accept: accept404 ? [404] : [] },
				ctx.now(),
			);
			if (!response.ok) return response;
			return { ok: true, value: response.value.status === 404 ? undefined : response.value.body };
		},
		async hash(url, check) {
			const where = redactUrl(url);
			const response = await fetchSource(
				http,
				{
					url,
					headers: { ...headers, accept: "application/octet-stream" },
					maxResponseBytes: SOURCE_HTTP_MAX_ARTIFACT_BYTES,
				},
				ctx.now(),
			);
			if (!response.ok) return response;
			const bytes = bodyBytes(response.value, where);
			if (!bytes.ok) return bytes;
			if (check && !check(bytes.value)) return upstreamInvalid(where, "package bytes do not match the registry's integrity value");
			return { ok: true, value: { digest: `sha256:${sha256Hex(bytes.value)}`, mediaType: "application/octet-stream" } };
		},
	};
}

function fixed(digest: string, mediaType: string) {
	return async (): Promise<Outcome<Resolved>> => ({ ok: true, value: { digest: `sha256:${digest}`, mediaType } });
}

function integrityCheck(integrity: string | undefined): ((bytes: Uint8Array) => boolean) | undefined {
	const match = integrity ? /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity.split(/\s+/)[0] ?? "") : null;
	const expected = match?.[1];
	if (!expected) return undefined;
	return (bytes) => createHash("sha512").update(bytes).digest("base64") === expected;
}

async function listNpm(locator: Locator, fetch: Fetcher): Promise<Outcome<Listing>> {
	const encoded = locator.name.startsWith("@") ? locator.name.replace("/", "%2f") : locator.name;
	const document = await fetch.json(`${locator.base}/${encoded}`);
	if (!document.ok) return document;
	const versions = field(document.value, "versions");
	if (!isRecord(versions)) return upstreamInvalid(locator.base, "npm packument has no versions");
	return {
		ok: true,
		value: {
			versions: Object.entries(versions).flatMap(([version, manifest]) => {
				const dist = field(manifest, "dist");
				const tarball = text(dist, "tarball");
				if (!tarball || !safeHttpsUrl(tarball)) return [];
				const check = integrityCheck(text(dist, "integrity"));
				// Without a sha512 integrity there is nothing to check the read against.
				if (!check) return [];
				return [{ version, resolve: () => fetch.hash(tarball, check) }];
			}),
		},
	};
}

async function listPypi(locator: Locator, fetch: Fetcher): Promise<Outcome<Listing>> {
	const document = await fetch.json(`${locator.base}/pypi/${encodeURIComponent(locator.name)}/json`);
	if (!document.ok) return document;
	const releases = field(document.value, "releases");
	if (!isRecord(releases)) return upstreamInvalid(locator.base, "PyPI document has no releases");
	return {
		ok: true,
		value: {
			versions: Object.entries(releases).flatMap(([version, files]) => {
				if (!isList(files) || files.length === 0) return [];
				if (files.some((file) => field(file, "yanked") === true)) return [];
				const ordered = [...files].sort((a, b) => {
					const sdist = Number(text(b, "packagetype") === "sdist") - Number(text(a, "packagetype") === "sdist");
					return sdist || (text(a, "filename") ?? "").localeCompare(text(b, "filename") ?? "");
				});
				const sha = text(field(ordered[0], "digests"), "sha256");
				if (!sha || !HEX64.test(sha)) return [];
				return [{ version, resolve: fixed(sha, "application/octet-stream") }];
			}),
		},
	};
}

async function listCargo(locator: Locator, fetch: Fetcher): Promise<Outcome<Listing>> {
	const body = await fetch.textBody(`${locator.base}/${cratesIndexPath(locator.name)}`);
	if (!body.ok) return body;
	const lines = (body.value ?? "").split("\n").filter((line) => line.trim() !== "");
	return {
		ok: true,
		value: {
			versions: lines.flatMap((line) => {
				const entry = parseJson(line);
				const version = text(entry, "vers");
				const cksum = text(entry, "cksum");
				if (!version || !cksum || !HEX64.test(cksum) || field(entry, "yanked") === true) return [];
				return [{ version, resolve: fixed(cksum, "application/x-tar") }];
			}),
		},
	};
}

async function listRubygems(locator: Locator, fetch: Fetcher): Promise<Outcome<Listing>> {
	const document = await fetch.json(`${locator.base}/api/v1/versions/${encodeURIComponent(locator.name)}.json`);
	if (!document.ok) return document;
	if (!isList(document.value)) return upstreamInvalid(locator.base, "RubyGems versions is not a list");
	return {
		ok: true,
		value: {
			versions: document.value.flatMap((entry) => {
				const version = text(entry, "number");
				const sha = text(entry, "sha");
				const platform = text(entry, "platform") ?? "ruby";
				if (!version || !sha || !HEX64.test(sha) || platform !== "ruby") return [];
				return [{ version, resolve: fixed(sha, "application/octet-stream") }];
			}),
		},
	};
}

async function listNuget(locator: Locator, fetch: Fetcher): Promise<Outcome<Listing>> {
	const id = locator.name.toLowerCase();
	const document = await fetch.json(`${locator.base}/${encodeURIComponent(id)}/index.json`);
	if (!document.ok) return document;
	const versions = field(document.value, "versions");
	if (!isList(versions)) return upstreamInvalid(locator.base, "NuGet flat container has no versions");
	return {
		ok: true,
		value: {
			versions: versions.filter(isText).map((raw) => {
				const version = raw.toLowerCase();
				const url = `${locator.base}/${encodeURIComponent(id)}/${encodeURIComponent(version)}/${encodeURIComponent(`${id}.${version}.nupkg`)}`;
				return { version: raw, resolve: () => fetch.hash(url) };
			}),
		},
	};
}

async function listMaven(locator: Locator, fetch: Fetcher): Promise<Outcome<Listing>> {
	const [group = "", artifact = "", extension = "jar"] = locator.name.split(":");
	const root = `${locator.base}/${group.split(".").map(encodeURIComponent).join("/")}/${encodeURIComponent(artifact)}`;
	const xml = await fetch.textBody(`${root}/maven-metadata.xml`);
	if (!xml.ok) return xml;
	const versions = [...(xml.value ?? "").matchAll(/<version>\s*([^<\s]{1,128})\s*<\/version>/g)].flatMap((match) =>
		match[1] ? [match[1]] : [],
	);
	return {
		ok: true,
		value: {
			versions: versions.map((version) => {
				const file = `${root}/${encodeURIComponent(version)}/${encodeURIComponent(`${artifact}-${version}.${extension}`)}`;
				return {
					version,
					resolve: async (): Promise<Outcome<Resolved>> => {
						const sidecar = await fetch.textBody(`${file}.sha256`, true);
						if (!sidecar.ok) return sidecar;
						const value = sidecar.value?.trim().split(/\s+/)[0]?.toLowerCase();
						if (value && HEX64.test(value)) return { ok: true, value: { digest: `sha256:${value}`, mediaType: "application/java-archive" } };
						return fetch.hash(file);
					},
				};
			}),
		},
	};
}

const LISTERS: Readonly<Record<PackageEcosystem, (locator: Locator, fetch: Fetcher) => Promise<Outcome<Listing>>>> = {
	npm: listNpm,
	pypi: listPypi,
	maven: listMaven,
	nuget: listNuget,
	cargo: listCargo,
	rubygems: listRubygems,
};

export function createPackageRegistryDriver(
	d: Readonly<{ http: HttpTransport; credentials?: CredentialResolver }>,
): SubscriptionDriver {
	return {
		kind: SubscriptionKind.PACKAGE_REGISTRY,
		async discover(input, ctx) {
			const { subscription } = input;
			const locator = parsePackageLocator(subscription);
			if (!locator.ok) return locator;
			const headers = await credentialHeaders(d.credentials, subscription.credentialRef);
			if (!headers.ok) return headers;
			const fetch = fetcher(d.http, headers.value, ctx);
			const listing = await LISTERS[locator.value.ecosystem](locator.value, fetch);
			if (!listing.ok) return listing;
			const resolvers = new Map<string, () => Promise<Outcome<Resolved>>>();
			const placeholders: Candidate[] = listing.value.versions.map((item) => {
				resolvers.set(item.version, item.resolve);
				return {
					version: item.version,
					rank: item.version,
					artifact: create(ArtifactRefSchema, {}),
				};
			});
			const picked = selectCandidates(subscription, placeholders, input.cursor);
			const artifacts = [];
			for (const candidate of picked.selected) {
				const resolve = resolvers.get(candidate.version);
				if (!resolve) continue;
				const resolved = await resolve();
				if (!resolved.ok) return resolved;
				const artifact = create(ArtifactRefSchema, {
					name: subscription.artifactName || locator.value.name,
					kind: subscription.artifactKind || ArtifactKind.PACKAGE,
					digest: resolved.value.digest,
					coordinate: packagePurl(locator.value.ecosystem, locator.value.name, candidate.version),
					mediaType: resolved.value.mediaType,
					ecosystem: locator.value.ecosystem,
				});
				artifacts.push(discovered(input, { ...candidate, artifact }, ctx));
			}
			return { ok: true, value: { artifacts, cursor: picked.cursor } };
		},
	};
}
