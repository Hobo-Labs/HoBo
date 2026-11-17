import { externalBoundaryViolations } from "@hobo/bindles";

import type { CommandResult } from "../types/envelope.js";
import { type BindleLoaderOptions, loadBindleDefinition } from "./loader.js";

// Placement refuses a Bindle whose externals a Yard would hold (a Yard holds
// nothing external: @hobo/bindles externalBoundaryViolations). Every verb that
// places — `plan`, `up` and every family lifecycle — runs this first.

/** The refusal for a project whose Bindle declares an unmanaged external. */
export async function externalBoundaryRefusal(
	projectDir: string,
	command: string,
	loaderOptions?: BindleLoaderOptions,
): Promise<CommandResult | undefined> {
	const definition = await loadBindleDefinition(
		projectDir,
		loaderOptions ?? {},
	);
	if (definition === null) return undefined;
	const violations = externalBoundaryViolations(definition);
	if (violations.length === 0) return undefined;
	return {
		ok: false,
		status: "rejected",
		code: "HOBO_YARD_EXTERNAL_FORBIDDEN",
		message: `hobo ${command} rejected: ${violations.map((v) => v.message).join("; ")}`,
		remediation: violations.map((v) => `${v.resource}: ${v.remediation}`),
		data: {
			command,
			externals: violations.map((v) => v.resource),
		},
	};
}
