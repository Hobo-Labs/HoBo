/**
 * The `.env.schema` a proxied run reads: references only. One entry per
 * binding, in the form OpenSesame's `dev run` documents,
 *
 *     VERCEL_TOKEN=opensesameConnection(conn://acme/vercel,
 *       projection=legacy-token, paths="/v9/projects", methods="GET")
 *
 * The entry names a connection and bounds a scope; the token it stands for is
 * sealed in the person's store and never appears here. The renderer takes
 * parsed bindings only. A value the parser did not make (a spread copy, a literal,
 * an assigned object: the right fields, never checked) could add an entry, close
 * a quote or start a comment, so it is refused at run time with `schema_injection`
 * as well as at compile time.
 */

import {
	isParsedCredentialBinding,
	type ParsedCredentialBinding,
} from "./binding.js";
import { OpenSesameAdapterError } from "./errors.js";

const HEADER = "# @defaultSensitive=false\n# ---\n";

function refuse(field: string): never {
	throw new OpenSesameAdapterError(
		"schema_injection",
		`${field} would not stay inside its .env.schema entry; the schema was not written`,
	);
}

/**
 * A binding is written into a file as it is, so it must be one the parser made:
 * a copy or a literal has the right fields and has not been checked.
 */
function assertParsed(binding: ParsedCredentialBinding): void {
	if (!isParsedCredentialBinding(binding))
		refuse("a binding that was not parsed");
}

function entry(binding: ParsedCredentialBinding): string {
	assertParsed(binding);
	return [
		"# @required @sensitive",
		`${binding.envName}=opensesameConnection(${binding.connection}, projection=${binding.projection}, paths="${binding.paths.join(",")}", methods="${binding.methods.join(",")}")`,
	].join("\n");
}

/** Code-unit order: the same on every machine and locale, unlike `localeCompare`. */
function compareCodeUnits(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}

/** The schema text for `bindings`, entries ordered by variable name. */
export function renderEnvSchema(
	bindings: readonly ParsedCredentialBinding[],
): string {
	const entries = [...bindings]
		.sort((left, right) => compareCodeUnits(left.envName, right.envName))
		.map(entry);
	if (entries.length === 0) return HEADER;
	return `${HEADER}\n${entries.join("\n\n")}\n`;
}
