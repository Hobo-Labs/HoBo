// `composeContinuousDelivery` (ADR-0182 C2): the one composition of
// @hobo/cd every surface uses (`hobo up`/`down`, `hobo deploy *`, `hobo serve
// cd`, broker `deliver`, MCP). It is `wireContinuousDelivery` over the default
// factory bindings; tests and hosts may override any factory.
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
