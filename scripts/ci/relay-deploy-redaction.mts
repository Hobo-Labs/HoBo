import {
	createProviderRedactor,
	LONG_TOKEN_RUN_PROFILE,
} from "../../packages/provider-redaction/dist/provider-redaction.js";

export const RELAY_DEPLOY_BEARER_PATTERN = /bearer\s+[A-Za-z0-9._~+/=ſK-]+/gi;

export const redactRelayDeployText = createProviderRedactor({
	...LONG_TOKEN_RUN_PROFILE,
	patterns: [RELAY_DEPLOY_BEARER_PATTERN],
});
