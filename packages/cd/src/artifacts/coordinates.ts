// Coordinate parsing at the verifier boundary. A coordinate is attacker-
// influenced text (it arrives in a manifest), so parsing is total: anything
// that is not a well-formed purl, OCI digest reference or https base URL is
// undefined, and every URL the verifier will fetch is https without userinfo.

export type Purl = Readonly<{
	type: string;
	namespace: string;
	name: string;
	version: string;
	qualifiers: Readonly<Record<string, string>>;
}>;

function decode(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}

/** Package URL (purl spec). */
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
			const decoded = decode(pair.slice(at + 1));
			if (decoded === undefined) return undefined;
			qualifiers[pair.slice(0, at).toLowerCase()] = decoded;
		}
		rest = rest.slice(0, question);
	}
	let version = "";
	const lastSlash = rest.lastIndexOf("/");
	const lastAt = rest.lastIndexOf("@");
	if (lastAt > lastSlash) {
		const decoded = decode(rest.slice(lastAt + 1));
		if (decoded === undefined) return undefined;
		version = decoded;
		rest = rest.slice(0, lastAt);
	}
	const segments = rest.split("/").filter((segment) => segment !== "");
	const type = segments.shift()?.toLowerCase() ?? "";
	const rawName = segments.pop();
	if (!/^[a-z][a-z0-9.+-]*$/.test(type) || rawName === undefined)
		return undefined;
	const name = decode(rawName);
	const namespaceParts = segments.map(decode);
	if (
		name === undefined ||
		name === "" ||
		namespaceParts.some((part) => part === undefined)
	)
		return undefined;
	return {
		type,
		namespace: namespaceParts.join("/"),
		name,
		version,
		qualifiers,
	};
}

export type OciReference = Readonly<{
	/** Registry host as written (docker.io is mapped to registry-1.docker.io). */
	registry: string;
	repository: string;
	tag: string;
	/** `sha256:<hex>` the reference pins, or "" for a tag-only reference. */
	digest: string;
}>;

/**
 * `[oci://]host[:port]/repo/path[:tag][@sha256:<hex>]`. Docker Hub short
 * names are expanded the way the Docker CLI expands them.
 */
export function parseOciReference(value: string): OciReference | undefined {
	let rest = value.startsWith("oci://") ? value.slice("oci://".length) : value;
	if (rest === "" || /\s/.test(rest) || rest.includes("://")) return undefined;
	let digest = "";
	const at = rest.indexOf("@");
	if (at >= 0) {
		digest = rest.slice(at + 1);
		if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return undefined;
		rest = rest.slice(0, at);
	}
	const slash = rest.indexOf("/");
	if (slash === 0) return undefined;
	let registry = slash < 0 ? "docker.io" : rest.slice(0, slash);
	let path = slash < 0 ? rest : rest.slice(slash + 1);
	if (!/[.:]/.test(registry) && registry !== "localhost") {
		path = `${registry}/${path}`;
		registry = "docker.io";
	}
	let tag = "";
	const colon = path.lastIndexOf(":");
	if (colon > path.lastIndexOf("/")) {
		tag = path.slice(colon + 1);
		path = path.slice(0, colon);
		if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) return undefined;
	}
	if (
		!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(
			path,
		)
	)
		return undefined;
	if (registry === "docker.io" && !path.includes("/")) path = `library/${path}`;
	if (!/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(registry)) return undefined;
	return { registry, repository: path, tag, digest };
}

export function registryHost(reference: OciReference): string {
	return reference.registry === "docker.io"
		? "registry-1.docker.io"
		: reference.registry;
}

/** An https base URL with no userinfo, query or fragment; trailing slashes removed. */
export function httpsBase(value: string): string | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
		return undefined;
	if (url.search !== "" || url.hash !== "") return undefined;
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** True when an absolute URL is https, carries no userinfo, and is on `host`. */
export function sameHttpsHost(value: string, host: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			url.host === host
		);
	} catch {
		return false;
	}
}
