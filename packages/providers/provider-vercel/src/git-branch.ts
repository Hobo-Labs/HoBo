/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- SAFETY: this exported validator parses a branch name from untrusted deployment configuration. */
import { ResolverError } from "@hobo/core";

/** A real Git branch name, not a detached commit used as a scheduler track. */
export function vercelPreviewBranch(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > 200 ||
		!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) ||
		/^[a-f0-9]{40}$/iu.test(value) ||
		value.startsWith("refs/") ||
		value.includes("..") ||
		value.includes("//") ||
		value.endsWith("/") ||
		value.endsWith(".") ||
		value
			.split("/")
			.some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
	)
		throw new ResolverError(
			"RESOLVER_PRODUCT_UNSUPPORTED",
			"Vercel preview schedule requires an approved Git branch name",
		);
	return value;
}
