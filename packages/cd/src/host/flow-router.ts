import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import {
	CdDeliveryFlow,
	type DeliveryFlowTarget,
	UnsupportedDeliveryFlow,
} from "../domain/index.js";
import type { CdDeliveryFlowService } from "./rivet.js";

export type CdDeliveryFlowAdapter =
	Parameters<typeof CdDeliveryFlow.toLayer>[0] extends Effect.Effect<
		infer Service,
		infer _Err,
		infer _Req
	>
		? Service
		: never;

export function createCdDeliveryFlowRouterLayer(
	adapters: Readonly<Record<string, CdDeliveryFlowAdapter>>,
): Layer.Layer<CdDeliveryFlowService> {
	const registry = new Map<string, CdDeliveryFlowAdapter>(
		Object.entries(adapters),
	);

	const lookup = (flowTarget: DeliveryFlowTarget) => registry.get(flowTarget);

	return CdDeliveryFlow.toLayer(
		Effect.succeed({
			publishRevision: (input) => {
				const adapter = lookup(input.flowTarget);
				if (adapter === undefined) {
					return Effect.fail(
						new UnsupportedDeliveryFlow({
							flowKind: input.flowKind,
							flowTarget: input.flowTarget,
						}),
					);
				}
				return adapter.publishRevision(input);
			},
			observePullRequest: (input) => {
				const adapter = lookup(input.flowTarget);
				if (adapter === undefined) {
					return Effect.fail(
						new UnsupportedDeliveryFlow({
							flowKind: input.flowKind,
							flowTarget: input.flowTarget,
						}),
					);
				}
				return adapter.observePullRequest(input);
			},
			observeConvergence: (input) => {
				const adapter = lookup(input.flowTarget);
				if (adapter === undefined) {
					return Effect.fail(
						new UnsupportedDeliveryFlow({
							flowKind: input.flowKind,
							flowTarget: input.flowTarget,
						}),
					);
				}
				return adapter.observeConvergence(input);
			},
			rollbackRevision: (input) => {
				const adapter = lookup(input.flowTarget);
				if (adapter === undefined) {
					return Effect.fail(
						new UnsupportedDeliveryFlow({
							flowKind: input.flowKind,
							flowTarget: input.flowTarget,
						}),
					);
				}
				return adapter.rollbackRevision(input);
			},
		}),
	);
}
