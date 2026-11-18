import { fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import { SdkConformanceReportSchema } from "../_generated/sdk_conformance_pb.js";
import { cloneAsJson } from "../json.js";
import { parseSdkConformanceReport, serializeReportForPact } from "./parse.js";
import type { SdkConformanceReport } from "./types.js";

export function encodeSdkConformanceReport(
	report: SdkConformanceReport,
): Uint8Array {
	const parsed = parseSdkConformanceReport(serializeReportForPact(report));
	const wire = fromJson(
		SdkConformanceReportSchema,
		serializeReportForPact(parsed),
	);
	return toBinary(SdkConformanceReportSchema, wire);
}

export function decodeSdkConformanceReport(
	bytes: Uint8Array,
): SdkConformanceReport {
	const wire = fromBinary(SdkConformanceReportSchema, bytes);
	return parseSdkConformanceReport(
		cloneAsJson(
			toJson(SdkConformanceReportSchema, wire, { alwaysEmitImplicit: true }),
		),
	);
}
