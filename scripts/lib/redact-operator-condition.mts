import {
	JWT_DETECTOR,
	PRIVATE_KEY_DETECTOR,
	redactProviderText,
} from "../../packages/provider-redaction/dist/provider-redaction.js";

function providerTextSafeAfterRedaction(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	return !JWT_DETECTOR.test(trimmed) && !PRIVATE_KEY_DETECTOR.test(trimmed);
}

export function redactRealizerConditionText(message: string): string {
	const redacted = redactProviderText(message);
	if (!providerTextSafeAfterRedaction(redacted))
		return "The realizer reported a condition.";
	return redacted;
}

export const redactReleaseFreightOperatorMessage = redactRealizerConditionText;
