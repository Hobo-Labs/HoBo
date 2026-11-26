import { findLanguageSpecificGoldenIrField } from "./golden-ir.js";
import {
	type ConformanceFailure,
	SDK_PARITY_SCHEMA,
	type SdkParityInput,
	type SdkParityReport,
} from "./types.js";

const defaultAnnexCategories = [
	"error-mapping",
	"cancellation",
	"async-ordering",
	"ifc-side-effect-order",
] as const;

export function evaluateSdkParity(input: SdkParityInput): SdkParityReport {
	const failures: ConformanceFailure[] = [];
	const language = input?.language ?? "unknown";

	if (input?.goldenIr?.equivalent === false) {
		failures.push({ code: "golden-ir.mismatch" });
	}

	const languageLeak = findLanguageSpecificGoldenIrField(
		input?.goldenIr?.ir ?? [],
	);
	if (languageLeak) {
		failures.push({
			code: "golden-ir.language-leak",
			path: languageLeak.path,
			language,
		});
	}

	const passedCategories = new Set(
		(input?.semanticsAnnex?.vectors ?? [])
			.filter((vector) => vector?.passed === true)
			.map((vector) => vector.category),
	);
	const missingCategories = defaultAnnexCategories.filter(
		(category) => !passedCategories.has(category),
	);

	if (missingCategories.length > 0) {
		failures.push({
			code: "semantics-annex.missing-vector",
			categories: [...missingCategories],
		});
	}

	return {
		schema: SDK_PARITY_SCHEMA,
		ok: failures.length === 0,
		language,
		failures,
	};
}
