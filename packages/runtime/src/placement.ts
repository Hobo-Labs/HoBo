/**
 * Actor placement mode selection (ADR-0138).
 * Same defineActor / activateActor surface; host injection chooses native vs dapr.
 */

import type { ActorPlacementMode } from "@hobo/core";
import { parseActorPlacementMode } from "@hobo/core";
import type { JsonValue } from "./json.js";

import type { ActorHost } from "./ports.js";

export interface PlacementResolved {
	readonly mode: ActorPlacementMode;
	readonly host: ActorHost;
	readonly source: "explicit" | "camp-runtime" | "default";
}

export interface ResolveActorPlacementInput {
	readonly explicit?: JsonValue;
	readonly campRuntimeRequirements?: readonly string[];
	readonly nativeHost: ActorHost;
	readonly daprHost?: ActorHost;
	readonly rivetHost?: ActorHost;
	readonly celldHost?: ActorHost;
}

/**
 * Resolve which ActorHost backs defineActor for this Camp.
 * Default: native (ADR-0031). Dapr / Rivet only when Camp asks or explicit mode.
 * Explicit pins fail closed when the matching host is missing.
 */
export function resolveActorPlacement(
	input: ResolveActorPlacementInput,
): PlacementResolved {
	if (input.explicit !== undefined) {
		const mode = parseActorPlacementMode(input.explicit);
		if (mode === "dapr") {
			if (!input.daprHost) {
				throw new Error(
					"actor placement mode 'dapr' requires a Dapr-backed ActorHost",
				);
			}
			return { mode: "dapr", host: input.daprHost, source: "explicit" };
		}
		if (mode === "rivet") {
			if (!input.rivetHost) {
				throw new Error(
					"actor placement mode 'rivet' requires a Rivet-backed ActorHost",
				);
			}
			return { mode: "rivet", host: input.rivetHost, source: "explicit" };
		}
		if (mode === "celld") {
			if (!input.celldHost) {
				throw new Error(
					"actor placement mode 'celld' requires a celld-backed ActorHost",
				);
			}
			return { mode: "celld", host: input.celldHost, source: "explicit" };
		}
		return { mode: "native", host: input.nativeHost, source: "explicit" };
	}

	const requirements = input.campRuntimeRequirements ?? [];
	const wantsCelld = requirements.some(
		(r) => r === "celld" || r === "runtime-celld" || r.startsWith("celld:"),
	);
	if (wantsCelld) {
		if (!input.celldHost) {
			throw new Error(
				"Camp runtimeRequirements include celld but no celld ActorHost was injected",
			);
		}
		return {
			mode: "celld",
			host: input.celldHost,
			source: "camp-runtime",
		};
	}

	const wantsRivet = requirements.some(
		(r) => r === "rivet" || r === "runtime-rivet" || r.startsWith("rivet:"),
	);
	if (wantsRivet) {
		if (!input.rivetHost) {
			throw new Error(
				"Camp runtimeRequirements include rivet but no Rivet ActorHost was injected",
			);
		}
		return {
			mode: "rivet",
			host: input.rivetHost,
			source: "camp-runtime",
		};
	}

	const wantsDapr = requirements.some(
		(r) => r === "dapr" || r === "runtime-dapr" || r.startsWith("dapr:"),
	);
	if (wantsDapr) {
		if (!input.daprHost) {
			throw new Error(
				"Camp runtimeRequirements include dapr but no Dapr ActorHost was injected",
			);
		}
		return {
			mode: "dapr",
			host: input.daprHost,
			source: "camp-runtime",
		};
	}

	return { mode: "native", host: input.nativeHost, source: "default" };
}

/**
 * Signal an actor via the messaging surface (queue signal or topic).
 * Keeps actor messaging on the unified Messaging plane when a bus is present.
 */
export async function signalActor(
	messaging: {
		publish: (
			topic: string & { readonly __brand: "TopicName" },
			body: JsonValue,
			options?: { key?: string },
		) => Promise<JsonValue>;
	},
	actorType: string,
	actorKey: string,
	message: JsonValue,
): Promise<void> {
	// SAFETY: assertion to ``actors.${actorType}` as string & { readonly __brand: "TopicName"; }` is required at this boundary.
	const topic = `actors.${actorType}` as string & {
		readonly __brand: "TopicName";
	};
	await messaging.publish(topic, message, { key: actorKey });
}
