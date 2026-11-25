/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- SAFETY: manifest sorting is a local JSON compatibility boundary and token resolution is guarded by the wiring manifest contract. */
import { createHash } from "node:crypto";

import { LAZY_TOKEN_PATTERN, type WiringManifest } from "@hobo/bindles/wiring";
import type { BindingResolverPort } from "@hobo/core";
import { parseResourceId } from "@hobo/core";
import { must } from "@hobo/core/total-access";
import type { Camp } from "./types.js";

export class BindingResolutionError extends Error {
	readonly path: string;

	constructor(path: string, message: string) {
		super(`${path}: ${message}`);
		this.name = "BindingResolutionError";
		this.path = path;
	}
}

export type ResolvedEnv = Readonly<Record<string, string>>;

/**
 * Resolve lazy binding tokens for a Camp running on the local provider.
 * Provider is inherited from the enclosing Yard (derivedProviderId) or
 * explicitly required as "local" for bare-metal camps.
 */
export async function resolveLocalBindings(
	manifest: WiringManifest,
	camp: Camp,
	resolver: BindingResolverPort,
): Promise<ResolvedEnv> {
	const providerId = camp.derivedProviderId ?? "local";
	if (providerId !== "local") {
		throw new BindingResolutionError(
			"camp.derivedProviderId",
			`resolveLocalBindings requires local provider, got ${providerId}`,
		);
	}

	const env: Record<string, string> = {};
	for (const resource of Object.values(manifest.resources)) {
		for (const [key, value] of Object.entries(resource.env ?? {})) {
			const match = LAZY_TOKEN_PATTERN.exec(value);
			if (!match) {
				env[key] = value;
				continue;
			}
			const [, tokenResourceId, property] = match;
			const binding = await resolver.resolve(
				parseResourceId(must(tokenResourceId)),
				must(property),
			);
			env[key] = binding.value;
		}
	}

	return Object.freeze(env);
}

export function canonicalManifestHash(manifest: WiringManifest): string {
	const canonical = JSON.stringify(sortKeys(manifest));
	return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (!value || typeof value !== "object") {
		return value;
	}
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
	);
}
