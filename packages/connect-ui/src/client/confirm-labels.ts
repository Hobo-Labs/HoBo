import type { Spec } from "@json-render/core";
import { z } from "zod";

const ButtonPressSchema = z.object({
	press: z.object({ action: z.string() }),
});
const ButtonLabelSchema = z.object({ label: z.string() });

export function confirmLabelsForSpec(
	spec: Spec,
	confirmByAction: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
	const byLabel = new Map<string, string>();
	for (const [action, message] of confirmByAction) {
		for (const element of Object.values(spec.elements)) {
			if (element.type !== "Button") continue;
			const press = ButtonPressSchema.safeParse(element.on);
			if (!press.success || press.data.press.action !== action) continue;
			const label = ButtonLabelSchema.safeParse(element.props);
			if (label.success) byLabel.set(label.data.label, message);
		}
	}
	return byLabel;
}
