import {
	type AlchemyPrimitiveMapper,
	type AlchemyPrimitiveSupport,
	describeAlchemyPrimitiveSupport,
} from "./bindle.js";

const reportHasOwn = Object.hasOwn;
const reportCreate = Object.create;
const reportDefine = Object.defineProperty;
const reportFreeze = Object.freeze;

const RIVET_GAPS: Readonly<Record<string, string>> = Object.freeze({
	api: "No attested Rivet API source was supplied.",
	web: "No attested Rivet web source was supplied.",
	service: "No attested Rivet service source was supplied.",
	kv: "The standalone asynchronous Rivet key-value actor does not bind the synchronous HoBo WASI store or Rivet Bindle dependencies.",
	bucket:
		"The HoBo blobstore, object metadata, blob events and presigned URLs are not bound to a Rivet Bindle.",
	queue:
		"The standalone Rivet JSON queue does not bind the HoBo byte-and-attribute WIT queue or Bindle dependencies.",
	topic:
		"The synchronous HoBo Bindle and WIT topic dependencies are not bound to Rivet.",
	secret:
		"HoBo secret creation, access and configuration bindings are not implemented for Rivet.",
	data: "Rivet DurableObject state is available, but HoBo data read, write, query and administration are not bound.",
	schedule:
		"Rivet DurableObject alarms do not by themselves bind the dynamic HoBo scheduler port.",
	project:
		"Rivet pool ownership alone does not implement the HoBo project isolation port.",
	websocket:
		"Rivet WebSocket is available, but HoBo websocket lifecycle, sending, broadcast and subscription are not bound.",
	job: "HoBo job submission and completion are not bound to Rivet.",
	external:
		"External connection metadata, authorization and runtime binding are not mapped for Rivet.",
	container:
		"Rivet Pool and Services are available, but HoBo container image, endpoint and lifecycle requirements are not bound.",
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
	const support = describeAlchemyPrimitiveSupport(catalog, mappers);
	const report: RivetPrimitiveSupport[] = [];
	for (let index = 0; index < support.length; index++) {
		const row = support[index];
		if (row === undefined) throw new Error("support row is unavailable");
		let reason = "";
		if (row.status === "unsupported") {
			const gap = reportHasOwn(RIVET_GAPS, row.kind)
				? RIVET_GAPS[row.kind]
				: undefined;
			reason =
				gap ?? "No Rivet Bindle mapping is implemented for this primitive.";
		} else {
			if (row.unsupportedOperations.length > 0) {
				reason = "Unsupported operations: ";
				for (
					let position = 0;
					position < row.unsupportedOperations.length;
					position++
				) {
					const operation = row.unsupportedOperations[position];
					if (operation === undefined)
						throw new Error("support operation is unavailable");
					if (position > 0) reason += ", ";
					reason += operation;
				}
				reason += ".";
			}
			for (let position = 0; position < row.limitations.length; position++) {
				const limitation = row.limitations[position];
				if (limitation === undefined)
					throw new Error("support limitation is unavailable");
				if (reason.length > 0) reason += " ";
				reason += limitation;
			}
			if (reason.length === 0)
				reason =
					"The supplied mapper declares all catalog operations without additional limitations.";
		}
		const field: PropertyDescriptor = reportCreate(null);
		field.value = { ...row, reason };
		field.enumerable = true;
		field.configurable = true;
		field.writable = true;
		reportDefine(report, index, reportFreeze(field));
	}
	return report;
}
