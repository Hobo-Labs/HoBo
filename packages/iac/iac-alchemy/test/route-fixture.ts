import type { IacRoutePort } from "../src/port.js";

export function routeFixture(
	options: {
		readonly inventoryHash?: string;
		readonly consume?: () => boolean;
		readonly verify?: () => boolean;
		readonly loseCompletion?: boolean;
	} = {},
) {
	const calls = { direct: 0, consumed: 0, verified: 0, denied: 0 };
	const port: IacRoutePort = {
		persistence: "durable-cas",
		consumeAttempt: () => {
			calls.consumed++;
			return options.consume?.() ?? true;
		},
		verifyAttempt: () => {
			calls.verified++;
			return options.verify?.() ?? true;
		},
		async runDirect(input, run) {
			calls.direct++;
			const permit = {
				tenantId: input.tenantId,
				requestId: input.requestId,
				targetId: input.targetId,
				inventoryHash: options.inventoryHash ?? `sha256:${"c".repeat(64)}`,
				attemptId: "A".repeat(43),
			};
			const result = await run({
				permit,
				deny: async () => {
					calls.denied++;
				},
			});
			return options.loseCompletion
				? { status: "uncertain", code: "ROUTE_OUTCOME_UNKNOWN" }
				: { status: "executed", value: result.value };
		},
	};
	return { port, calls };
}
