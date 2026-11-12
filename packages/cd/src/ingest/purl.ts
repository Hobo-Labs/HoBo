// Package URLs (purl spec) at the ingest boundary: attestation subjects and
// CDEvent artifact ids are purls. Parsing is total: anything that is not a
// purl returns undefined, never a partial value.
import { create } from "@bufbuild/protobuf";
import { type ArtifactRef, ArtifactKind, ArtifactRefSchema, type FreightSourceRecord, SubscriptionKind } from "../_generated/cd_pb.js";

export type Purl = Readonly<{
	type: string;
	namespace: string;
	name: string;
	version: string;
	qualifiers: Readonly<Record<string, string>>;
}>;

function decodeComponent(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}

export function parsePurl(value: string): Purl | undefined {
	if (!value.startsWith("pkg:") || /\s/.test(value)) return undefined;
	let rest = value.slice("pkg:".length).replace(/^\/+/, "");
	const hash = rest.indexOf("#");
	if (hash >= 0) rest = rest.slice(0, hash);
	const qualifiers: Record<string, string> = {};
	const question = rest.indexOf("?");
	if (question >= 0) {
		for (const pair of rest.slice(question + 1).split("&")) {
			const at = pair.indexOf("=");
			if (at <= 0) return undefined;
			const decoded = decodeComponent(pair.slice(at + 1));
			if (decoded === undefined) return undefined;
			qualifiers[pair.slice(0, at).toLowerCase()] = decoded;
		}
		rest = rest.slice(0, question);
	}
	let version = "";
	const lastSlash = rest.lastIndexOf("/");
	const lastAt = rest.lastIndexOf("@");
	if (lastAt > lastSlash) {
		const decoded = decodeComponent(rest.slice(lastAt + 1));
		if (decoded === undefined) return undefined;
		version = decoded;
		rest = rest.slice(0, lastAt);
	}
	const segments = rest.split("/").filter((segment) => segment !== "");
	const type = segments.shift()?.toLowerCase() ?? "";
	const rawName = segments.pop();
	if (!/^[a-z][a-z0-9.+-]*$/.test(type) || rawName === undefined) return undefined;
	const name = decodeComponent(rawName);
	const namespace = segments.map(decodeComponent);
	if (name === undefined || name === "" || namespace.some((segment) => segment === undefined)) return undefined;
	return Object.freeze({ type, namespace: namespace.join("/"), name, version, qualifiers: Object.freeze(qualifiers) });
}

const PACKAGE_ECOSYSTEMS: Readonly<Record<string, string>> = Object.freeze({
	npm: "npm",
	nuget: "nuget",
	pypi: "pypi",
	maven: "maven",
	cargo: "cargo",
	gem: "rubygems",
});
const GIT_HOSTS: ReadonlySet<string> = new Set(["github", "gitlab", "bitbucket"]);

/** One attestation subject as an artifact. The subject name is the coordinate. */
export function artifactFromSubject(name: string, sha256Hex: string): ArtifactRef {
	const purl = parsePurl(name);
	const wasm = (purl?.name ?? name).endsWith(".wasm");
	let kind = wasm ? ArtifactKind.WASM_COMPONENT : ArtifactKind.PACKAGE;
	let ecosystem = "";
	if (purl && (purl.type === "oci" || purl.type === "docker")) {
		kind = ArtifactKind.OCI_IMAGE;
		ecosystem = "oci";
	} else if (purl && PACKAGE_ECOSYSTEMS[purl.type]) {
		kind = ArtifactKind.PACKAGE;
		ecosystem = PACKAGE_ECOSYSTEMS[purl.type] ?? "";
	} else if (purl && GIT_HOSTS.has(purl.type)) {
		kind = ArtifactKind.SOURCE_TREE;
		ecosystem = "git";
	}
	return create(ArtifactRefSchema, { name, kind, digest: `sha256:${sha256Hex}`, coordinate: name, ecosystem });
}

/** `scheme://host[:port]/path[:tag][@digest]` → `host[:port]/path`, lowercased. */
function stripLocator(locator: string): string {
	let stripped = locator
		.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
		.replace(/@.*$/, "")
		.replace(/\/+$/, "");
	const slash = stripped.lastIndexOf("/");
	const colon = stripped.lastIndexOf(":");
	if (slash >= 0 && colon > slash) stripped = stripped.slice(0, colon);
	return stripped.replace(/\.git$/, "").toLowerCase();
}

/**
 * Sources whose subscriptions watch the purl's repository. A match only
 * schedules a poll, which is a verified read, so this errs toward matching
 * (an extra poll is harmless; a missed one waits for the next interval).
 */
export function sourcesForPurl(purl: Purl, sources: readonly FreightSourceRecord[]): readonly string[] {
	const fullName = (purl.namespace ? `${purl.namespace}/${purl.name}` : purl.name).toLowerCase();
	const repositoryUrl = stripLocator(purl.qualifiers.repository_url ?? "");
	const names = new Set<string>();
	for (const source of sources) {
		for (const subscription of source.subscriptions) {
			const locator = stripLocator(subscription.locator);
			const ecosystem = PACKAGE_ECOSYSTEMS[purl.type];
			const matched =
				(subscription.kind === SubscriptionKind.OCI_REPOSITORY &&
					(purl.type === "oci" || purl.type === "docker") &&
					(repositoryUrl !== "" ? locator === repositoryUrl : locator === fullName || locator.endsWith(`/${fullName}`))) ||
				(subscription.kind === SubscriptionKind.PACKAGE_REGISTRY &&
					ecosystem !== undefined &&
					subscription.ecosystem === ecosystem &&
					subscription.locator.toLowerCase() === fullName) ||
				(subscription.kind === SubscriptionKind.GIT_REPOSITORY && GIT_HOSTS.has(purl.type) && locator.endsWith(`/${fullName}`));
			if (matched) names.add(source.name);
		}
	}
	return [...names].sort();
}
