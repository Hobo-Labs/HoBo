/**
 * What a run can leave behind about a surrogate without naming one: the
 * locator and provider, and digests of the connection reference and of the
 * declared scope (the sorted paths and methods). A receipt built from this can
 * say which grant a run held; holding it redeems nothing.
 */

import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";

import {
	type SurrogateEvidence,
	SurrogateEvidenceSchema,
} from "./_generated/adapter_opensesame_pb.js";
import {
	isParsedCredentialBinding,
	type ParsedCredentialBinding,
} from "./binding.js";
import { OpenSesameAdapterError } from "./errors.js";

function digest(text: string): string {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function surrogateEvidence(
	binding: ParsedCredentialBinding,
): SurrogateEvidence {
	if (!isParsedCredentialBinding(binding)) {
		throw new OpenSesameAdapterError(
			"binding_invalid",
			"evidence is made from a binding the parser made",
		);
	}
	const scope = JSON.stringify({
		paths: [...binding.paths].sort(),
		methods: [...binding.methods].sort(),
	});
	return Object.freeze(
		create(SurrogateEvidenceSchema, {
			locator: binding.locator,
			provider: binding.provider,
			connectionDigest: digest(binding.connection),
			scopeDigest: digest(scope),
		}),
	);
}
