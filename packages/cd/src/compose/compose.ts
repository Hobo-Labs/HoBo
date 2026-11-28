import type { CdFactories } from "../ports.js";
import { defaultCdFactories } from "./defaults.js";
import {
	type CdComposeInput,
	type ComposedContinuousDelivery,
	wireContinuousDelivery,
} from "./wire.js";

export type ComposeContinuousDeliveryInput = Omit<CdComposeInput, "factories"> &
	Readonly<{ factories?: Partial<CdFactories> }>;

export function composeContinuousDelivery(
	input: ComposeContinuousDeliveryInput,
): ComposedContinuousDelivery {
	return wireContinuousDelivery({
		...input,
		factories: { ...defaultCdFactories, ...input.factories },
	});
}
