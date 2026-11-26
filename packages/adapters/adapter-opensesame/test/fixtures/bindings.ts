import {
	type ParsedCredentialBinding,
	parseCredentialBindings,
} from "../../src/binding.js";
import type { JsonObject } from "../../src/json.js";

/** The bindings a test starts from: one bounded vercel binding, references only. */
export function vercelRecord(overrides: JsonObject = {}) {
	return {
		locator: "hobo-token://vercel/deploy",
		connection: "conn://acme/vercel",
		provider: "vercel",
		env_name: "VERCEL_TOKEN",
		paths: ["/v9/projects", "/v13/deployments"],
		methods: ["GET", "POST"],
		projection: "legacy-token",
		...overrides,
	};
}

export function parsed(
	...records: JsonObject[]
): readonly ParsedCredentialBinding[] {
	return parseCredentialBindings({
		bindings: records.length > 0 ? records : [vercelRecord()],
	});
}

export function onlyBinding(
	overrides: JsonObject = {},
): ParsedCredentialBinding {
	const [binding] = parsed(vercelRecord(overrides));
	if (binding === undefined) throw new Error("fixture produced no binding");
	return binding;
}
