import type { OtelAttributes, TelemetrySink } from "../ports.js";

export const ARTIFACT_METRICS = Object.freeze({
	stored: "hobo.cd.artifact.stored",
	storedBytes: "hobo.cd.artifact.stored.bytes",
	deleted: "hobo.cd.artifact.deleted",
	corrupt: "hobo.cd.artifact.corrupt",
	verified: "hobo.cd.artifact.verify",
	provenance: "hobo.cd.provenance.verify",
} as const);

export function emit(
	sink: TelemetrySink | undefined,
	name: string,
	atMs: number,
	attributes: OtelAttributes,
	value = 1,
	unit = "{event}",
): void {
	sink
		?.metrics([{ name, kind: "counter", value, unit, atMs, attributes }])
		.catch(() => undefined);
}
