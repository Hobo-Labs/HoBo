import {
	createProviderRedactor,
	GLUED_BEARER_PATTERN,
	LONG_TOKEN_RUN_PROFILE,
} from "../../packages/provider-redaction/dist/provider-redaction.js";

export const redactRelayDeployText = createProviderRedactor({
	...LONG_TOKEN_RUN_PROFILE,
	patterns: [GLUED_BEARER_PATTERN],
	decodePercent: true,
	keep: /\bHOBO_[A-Z0-9_]+\b/g,
});
