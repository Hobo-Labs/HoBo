import type { ConfigField } from "../steps.js";

export function formInitialState(fields: readonly ConfigField[]) {
	const form: Record<string, string> = {};
	for (const field of fields) {
		if (field.kind === "secret") continue;
		if (field.value !== undefined && field.value !== "")
			form[field.name] = field.value;
	}
	return { form };
}
