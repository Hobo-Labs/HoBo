import type { HealthReport } from "../ports.js";
import { CD_SERVICE_STEPS } from "./service.js";

const SAFE_CHECK_NAMES = new Set([
	"started",
	"store",
	"drain",
	"issuer",
	"conductor",
	...CD_SERVICE_STEPS.map((step) => `step:${step}`),
]);
const GATING_CHECK_NAMES = new Set([
	"started",
	"store",
	"step:sources",
	"issuer",
	"conductor",
	"reconcilers",
]);
const REQUIRED_CHECK_NAMES = ["started", "store", "step:sources"] as const;

export function sanitizedCdHealth(report: HealthReport): HealthReport {
	const checks: { name: string; ok: boolean; detail: string }[] = [];
	let reconcilers: boolean | undefined;
	let other: boolean | undefined;
	let valid = report.ok === true || report.ok === false;
	for (const check of report.checks) {
		if (check.ok !== true && check.ok !== false) valid = false;
		const ok = check.ok === true;
		if (check.name === "reconcilers" || check.name.startsWith("reconciler:")) {
			reconcilers = (reconcilers ?? true) && ok;
		} else if (check.name === "dependencies") {
			other = (other ?? true) && ok;
		} else if (SAFE_CHECK_NAMES.has(check.name)) {
			checks.push({
				name: check.name,
				ok,
				detail: ok ? "ok" : "unavailable",
			});
		} else {
			other = (other ?? true) && ok;
		}
	}
	if (reconcilers !== undefined)
		checks.push({
			name: "reconcilers",
			ok: reconcilers,
			detail: reconcilers ? "ok" : "unavailable",
		});
	if (other !== undefined)
		checks.push({
			name: "dependencies",
			ok: other,
			detail: other ? "ok" : "unavailable",
		});
	const present = new Set(checks.map((check) => check.name));
	return {
		ok:
			valid &&
			REQUIRED_CHECK_NAMES.every((name) => present.has(name)) &&
			checks.every((check) => !GATING_CHECK_NAMES.has(check.name) || check.ok),
		checks,
	};
}
