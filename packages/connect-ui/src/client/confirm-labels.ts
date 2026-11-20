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
		const element = Object.values(spec.elements).find((candidate) => {
			if (candidate.type !== "Button") return false;
			const press = ButtonPressSchema.safeParse(candidate.on);
			return press.success && press.data.press.action === action;
		});
		if (element === undefined) continue;
		const label = ButtonLabelSchema.safeParse(element.props);
		if (label.success) byLabel.set(label.data.label, message);
	}
	return byLabel;
}
