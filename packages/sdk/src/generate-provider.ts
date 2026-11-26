import { deepFreeze, SdkDeclarationError } from "./errors.js";
import { GENERATE_PROVIDER_SCHEMA } from "./schema.js";

// Parsed generation request consumed by executeProviderGeneration. The execution
// pipeline fetches documentation, synthesizes an OpenAPI model through a configured
// (optionally self-hosted) model when needed, emits a callable HTTP provider,
// exercises every operation, and signs the verified artifact. Request creation
// itself performs no external effects; the operator supplies execution context.

// The fixed pipeline stages a generation request declares, in order.
export const GENERATE_PROVIDER_PIPELINE = Object.freeze([
	"scaffold",
	"llm-fill",
	"sandbox-conformance",
	"sign",
] as const);

// domain-view: authored provider-generation request; wire form is GenerateProviderRequest in data-models/sdk.proto.
export interface GenerateProviderRequest {
	readonly schema: string;
	readonly docsUrl: string;
	readonly pipeline: readonly string[];
}

export async function generateProvider(
	docsUrl: string,
): Promise<GenerateProviderRequest> {
	let parsed: URL;
	try {
		parsed = new URL(docsUrl);
	} catch {
		throw new SdkDeclarationError(
			"generateProvider",
			"docsUrl",
			"must be a URL",
		);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new SdkDeclarationError(
			"generateProvider",
			"docsUrl",
			"must be an http(s) URL",
		);
	}

	return deepFreeze({
		schema: GENERATE_PROVIDER_SCHEMA,
		docsUrl: parsed.toString(),
		pipeline: [...GENERATE_PROVIDER_PIPELINE],
	});
}
