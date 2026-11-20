import type { Spec } from "@json-render/core";
import { z } from "zod";

import type { ConfigField } from "../steps.js";

const ElementNameSchema = z.object({ name: z.string() }).passthrough();

export function formInitialState(
	spec: Spec,
	fields: readonly ConfigField[],
) {
	const form: Record<string, string> = {};
	for (const field of fields) {
		if (field.kind === "secret") continue;
		if (field.value !== undefined && field.value !== "")
			form[field.name] = field.value;
	}
	for (const element of Object.values(spec.elements)) {
		if (element.type !== "Radio") continue;
		const named = ElementNameSchema.safeParse(element.props);
		if (!named.success) continue;
		const options = z
			.object({ options: z.array(z.string()).optional() })
			.safeParse(element.props);
		if (!options.success) continue;
		const name = named.data.name;
		if (form[name] !== undefined) continue;
		const first = options.data.options?.[0];
		if (first !== undefined) form[name] = first;
	}
	return { form };
}