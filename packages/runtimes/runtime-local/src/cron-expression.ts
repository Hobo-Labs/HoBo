import { Cron } from "croner";

export function nextCronExpressionFire(
	expression: string,
	timezone: string,
	afterMs: number,
): number {
	const fields = expression.trim().split(/\s+/u);
	if (
		expression.length === 0 ||
		expression.length > 256 ||
		(fields.length !== 5 && fields.length !== 6 && !expression.startsWith("@"))
	) {
		throw new TypeError(
			`Invalid cron expression: ${JSON.stringify(expression)}`,
		);
	}
	try {
		const pattern = new Cron(expression, {
			timezone,
			paused: true,
			domAndDow: false,
		});
		const next = pattern.nextRun(new Date(afterMs));
		const nextMs = next?.getTime();
		if (
			nextMs === undefined ||
			!Number.isSafeInteger(nextMs) ||
			nextMs <= afterMs
		) {
			throw new Error("no future occurrence");
		}
		return nextMs;
	} catch (error) {
		throw new TypeError(
			`Invalid cron expression or timezone: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
