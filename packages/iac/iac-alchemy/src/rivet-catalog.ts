import {
	type AlchemyPrimitiveMapper,
	type AlchemyPrimitiveSupport,
	describeAlchemyPrimitiveSupport,
} from "./bindle.js";

const RIVET_GAPS: Readonly<Record<string, string>> = Object.freeze({
	api: "No attested Rivet API source was supplied.",
	web: "No attested Rivet web source was supplied.",
	service: "No attested Rivet service source was supplied.",
	kv: "The HoBo WASI key-value operations and their consistency are not bound to a Rivet Bindle.",
	bucket:
		"The HoBo blobstore, object metadata, blob events and presigned URLs are not bound to a Rivet Bindle.",
	queue:
		"The standalone Rivet JSON queue does not bind the HoBo byte-and-attribute WIT queue or Bindle dependencies.",
	topic:
		"Rivet DurableStream supplies append and replay, but not the consumer-group leases, acknowledgements and dead-letter behavior of HoBo messaging.",
	secret:
		"HoBo secret creation, access and configuration bindings are not implemented for Rivet.",
	data: "HoBo data read, write, query and administration bindings are not implemented for Rivet.",
	schedule: "The dynamic HoBo scheduler is not bound to Rivet.",
	project:
		"Rivet pool ownership alone does not implement the HoBo project isolation port.",
	websocket:
		"HoBo websocket lifecycle, sending, broadcast and subscription are not bound to Rivet.",
	job: "HoBo job submission and completion are not bound to Rivet.",
	external:
		"External connection metadata, authorization and runtime binding are not mapped for Rivet.",
	container:
		"Container image, endpoint and lifecycle requirements are not mapped for Rivet Bindles.",
	"wasm-component":
		"HoBo WASI component execution and imported runtime ports are not mapped for Rivet.",
	flag: "HoBo feature-flag evaluation and mutation are not bound to Rivet.",
	auth: "HoBo identity verification and session operations are not bound to Rivet.",
	crypto:
		"HoBo cryptographic key lifecycle and operations are not bound to Rivet.",
	notify: "HoBo notification delivery is not bound to Rivet.",
	guardrail: "HoBo guardrail evaluation is not bound to Rivet.",
	ui: "HoBo UI rendering and driving are not bound to Rivet.",
	experiment: "HoBo experiment assignment and analysis are not bound to Rivet.",
	rollout: "HoBo rollout progression and rollback are not bound to Rivet.",
});

export interface RivetPrimitiveSupport extends AlchemyPrimitiveSupport {
	readonly reason: string;
}

/** Describe the selected Rivet mappings against every supplied HoBo catalog entry. */
export function describeRivetPrimitiveSupport<
	Entrypoint,
	Requirements,
	Services,
>(
	catalog: readonly {
		readonly factory: string;
		readonly allowVerbs: readonly string[];
	}[],
	mappers: Readonly<
		Record<string, AlchemyPrimitiveMapper<Entrypoint, Requirements, Services>>
	>,
): RivetPrimitiveSupport[] {
	return describeAlchemyPrimitiveSupport(catalog, mappers).map((support) => {
		if (support.status === "unsupported") {
			const gap = Object.hasOwn(RIVET_GAPS, support.kind)
				? RIVET_GAPS[support.kind]
				: undefined;
			return {
				...support,
				reason:
					gap ?? "No Rivet Bindle mapping is implemented for this primitive.",
			};
		}
		const reasons = [...support.limitations];
		if (support.unsupportedOperations.length)
			reasons.unshift(
				`Unsupported operations: ${support.unsupportedOperations.join(", ")}.`,
			);
		const reason = reasons.length
			? reasons.join(" ")
			: "The supplied mapper declares all catalog operations without additional limitations.";
		return { ...support, reason };
	});
}
