// Repository keys: the one normalized identity a webhook payload and a
// subscription locator are compared by. A nudge schedules every source with a
// subscription whose key matches a key the (verified) payload names.
import {
	SubscriptionKind,
	type SubscriptionRecord,
} from "../../_generated/cd_pb.js";
import { parseOciLocator } from "../drivers/oci.js";
import { packagePurl, parsePackageLocator } from "../drivers/packages.js";

/** `oci:<registry>/<repository>` for an image reference with or without tag/digest. */
export function ociKey(reference: string): string | undefined {
	const withoutScheme = reference.replace(/^[a-z]+:\/\//i, "");
	const withoutDigest = withoutScheme.split("@")[0] ?? "";
	const lastSlash = withoutDigest.lastIndexOf("/");
	const colon = withoutDigest.lastIndexOf(":");
	const repository = colon > lastSlash ? withoutDigest.slice(0, colon) : withoutDigest;
	const parsed = parseOciLocator(repository.toLowerCase());
	return parsed.ok ? `oci:${parsed.value.host}/${parsed.value.repository}` : undefined;
}

/** `git:<host><path>` without scheme, credentials, `.git` or trailing slash. */
export function gitKey(url: string): string | undefined {
	try {
		const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
		const path = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
		if (path === "" || path === "/") return undefined;
		return `git:${parsed.host.toLowerCase()}${path.toLowerCase()}`;
	} catch {
		return undefined;
	}
}

/** `url:<origin><path>` for an HTTP index (query dropped). */
export function urlKey(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		return `url:${parsed.origin.toLowerCase()}${parsed.pathname}`;
	} catch {
		return undefined;
	}
}

/** `pkg:<type>/<name>` from a purl (version, qualifiers and subpath dropped). */
export function purlKey(purl: string): string | undefined {
	const match = /^pkg:([a-z0-9.+-]+)\/([^@?#]+)/i.exec(purl);
	if (!match?.[1] || !match[2]) return undefined;
	const type = match[1].toLowerCase();
	if (type === "oci" || type === "docker") {
		const repositoryUrl = /[?&]repository_url=([^&#]+)/.exec(purl)?.[1];
		if (repositoryUrl) return ociKey(decodeURIComponent(repositoryUrl));
		if (type === "docker") return ociKey(`docker.io/${decodeURIComponent(match[2])}`);
		return undefined;
	}
	const name = match[2]
		.split("/")
		.map((part) => decodeURIComponent(part))
		.join("/");
	return `pkg:${type}/${type === "pypi" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name.toLowerCase()}`;
}

/** Keys of one subscription; HOBO_CI and HOBO_RAIL are never nudged from outside. */
export function subscriptionKeys(subscription: SubscriptionRecord): readonly string[] {
	switch (subscription.kind) {
		case SubscriptionKind.OCI_REPOSITORY: {
			const key = ociKey(subscription.locator);
			return key ? [key] : [];
		}
		case SubscriptionKind.GIT_REPOSITORY: {
			const key = gitKey(subscription.locator);
			return key ? [key] : [];
		}
		case SubscriptionKind.HTTP_INDEX: {
			const key = urlKey(subscription.locator);
			return key ? [key] : [];
		}
		case SubscriptionKind.PACKAGE_REGISTRY: {
			const locator = parsePackageLocator(subscription);
			if (!locator.ok) return [];
			const key = purlKey(packagePurl(locator.value.ecosystem, locator.value.name, "0"));
			return key ? [key] : [];
		}
		default:
			return [];
	}
}
