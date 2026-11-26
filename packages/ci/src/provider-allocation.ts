import { divideDecimalAtMost } from "./accounting.js";

/**
 * Convert a remaining shared 2-vCPU Linux minute balance to minutes usable by
 * one selected runner SKU. Unknown labels are refused rather than guessing a
 * conversion. The caller must obtain an authoritative, current account balance.
 */
export function providerFreeRunnerMinutes(input: {
	provider: "blacksmith" | "depot";
	runsOn: string;
	remainingBaseMinutes: number;
}): number {
	let cpus: number;
	if (input.provider === "blacksmith") {
		const match =
			/^blacksmith-(2|4|8|16|32)vcpu-ubuntu-(?:2204|2404|2604)$/.exec(
				input.runsOn,
			);
		if (!match?.[1]) throw new Error("unsupported Blacksmith Linux runner SKU");
		cpus = Number(match[1]);
	} else if (input.provider === "depot") {
		const match = /^depot-ubuntu-24\.04(?:-(4|8|16|32|64))?$/.exec(
			input.runsOn,
		);
		if (!match) throw new Error("unsupported Depot Linux runner SKU");
		cpus = match[1] ? Number(match[1]) : 2;
	} else {
		throw new Error("unsupported allocation provider");
	}
	return divideDecimalAtMost(input.remainingBaseMinutes, cpus / 2);
}
