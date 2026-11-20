import type { Spec } from "@json-render/core";
import { z } from "zod";

type ElementOn = NonNullable<Spec["elements"][string]["on"]>;

const PressBindingSchema = z.object({
	press: z.object({ action: z.string() }),
});

export function pressActionOf(on: ElementOn | undefined): string | undefined {
	const parsed = PressBindingSchema.safeParse(on);
	return parsed.success ? parsed.data.press.action : undefined;
}

export function confirmForPressAction(
	action: string | undefined,
	confirmByAction: ReadonlyMap<string, string>,
): string | undefined {
	return action === undefined ? undefined : confirmByAction.get(action);
}

export function specWithPressActions(spec: Spec): Spec {
	const elements: Spec["elements"] = {};
	for (const [id, element] of Object.entries(spec.elements)) {
		const action = pressActionOf(element.on);
		elements[id] =
			element.type === "Button" && action !== undefined
				? {
						...element,
						props: { ...element.props, pressAction: action },
					}
				: element;
	}
	return { ...spec, elements };
}
