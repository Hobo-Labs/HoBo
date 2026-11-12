/**
 * The `infisical` SecretRef scheme of `@hobo/bindings`:
 * `infisical://<projectId>/<environment>/<folder>/…/<secretKey>`.
 * A reference names where a secret lives, never its value.
 */

import { parseSecretRef, type SecretRef } from "@hobo/bindings";
import {
	type InfisicalSecretKey,
	type ParsedInfisicalBinding,
	parseInfisicalBinding,
	parseInfisicalSecretKey,
} from "./binding.js";
import { InfisicalError } from "./errors.js";

export function infisicalSecretRef(
	binding: ParsedInfisicalBinding,
	secretKey: string,
): SecretRef {
	const key = parseInfisicalSecretKey(secretKey);
	const folders = binding.secretPath === "/" ? "" : binding.secretPath;
	return parseSecretRef(
		`infisical://${binding.projectId}/${binding.environment}${folders}/${key}`,
	).ref;
}

/** The binding and key a reference names; the site comes from the deployment. */
export function parseInfisicalSecretRef(
	ref: string,
	siteUrl?: string,
): Readonly<{
	binding: ParsedInfisicalBinding;
	secretKey: InfisicalSecretKey;
}> {
	const parsed = parseSecretRef(ref);
	const [environment, ...rest] = parsed.path;
	const secretKey = rest.at(-1);
	if (
		parsed.scheme !== "infisical" ||
		parsed.field !== undefined ||
		environment === undefined ||
		secretKey === undefined
	)
		throw new InfisicalError("secret reference", "invalid-input");
	return Object.freeze({
		binding: parseInfisicalBinding({
			siteUrl,
			projectId: parsed.authority,
			environment,
			secretPath: `/${rest.slice(0, -1).join("/")}`,
		}),
		secretKey: parseInfisicalSecretKey(secretKey),
	});
}
