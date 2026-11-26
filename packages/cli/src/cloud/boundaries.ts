import { externalBoundaryViolations } from "@hobo/bindles";

import type { CommandResult } from "../types/envelope.js";
import { loadBindleDefinition } from "./loader.js";

export async function externalBoundaryRefusal(
	projectDir: string,
	command: string,
): Promise<CommandResult | undefined> {
	const definition = await loadBindleDefinition(projectDir);
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
