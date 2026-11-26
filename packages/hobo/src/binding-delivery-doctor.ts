/**
 * Pure binding-delivery / 12-factor integrity section for `hobo doctor` (ADR-0141/0142).
 */

import {
	evaluateBindingDeliveryGate,
	isForbiddenSecretEnvKey,
} from "@hobo/bindles";

export type BindingDeliveryDoctorSection = Readonly<{
	adr: "ADR-0141" | "ADR-0142";
	membrane: "wit-link-provider";
	twelveFactor: "schema-and-links-not-password-env";
	forbiddenEnvKeysInProcess: readonly string[];
	gateOk: boolean;
	summary: string;
	remediation: readonly string[];
}>;

/**
 * Inspect ambient process env for secret-shaped keys (diagnostic only;
 * does not print values).
 */
export function buildBindingDeliveryDoctorSection(
	env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
) {
	const forbidden: string[] = [];
	for (const key of Object.keys(env)) {
		if (isForbiddenSecretEnvKey(key) && env[key]) {
			forbidden.push(key);
		}
	}
	const gate = evaluateBindingDeliveryGate({ env });
	const remediation: string[] = [];
	if (!gate.ok || forbidden.length > 0) {
		remediation.push(
			"Remove ConnectionStrings__* / credential env; use WIT links + ctx.bindings / fromBinding (ADR-0141).",
		);
		remediation.push(
			"Non-secret config: linked wasi:config provider; residual vaults optional only (ADR-0142).",
		);
	}
	const report: BindingDeliveryDoctorSection = {
		adr: "ADR-0141",
		membrane: "wit-link-provider",
		twelveFactor: "schema-and-links-not-password-env",
		forbiddenEnvKeysInProcess: Object.freeze(forbidden),
		gateOk: gate.ok,
		summary: gate.ok
			? "binding-delivery: links-only membrane (no secret-shaped env detected)"
			: gate.summary,
		remediation: Object.freeze(remediation),
	};
	return { report, remediation: report.remediation };
}
