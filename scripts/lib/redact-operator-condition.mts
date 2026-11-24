import { redactProviderText } from "../../packages/provider-redaction/dist/provider-redaction.js";

export function redactRealizerConditionText(message: string): string {
	return redactProviderText(message);
}

export const redactReleaseFreightOperatorMessage = redactRealizerConditionText;
