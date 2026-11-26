import { isJsonObject, isJsonString } from "./json.js";
import type { BindleDefinition, ProviderAnnotation } from "./types.js";

export const CADENCE_OPTION = "cadence" as const;

const CRON = /^\S+(\s+\S+){4}$/u;

export class CadenceError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = "CadenceError";
	}
}

export function cadence(cron: string): ProviderAnnotation {
	const expression = cron.trim();
	if (!CRON.test(expression))
		throw new CadenceError(
			`cadence ${JSON.stringify(cron)} must be a five-field cron expression`,
		);
	return Object.freeze({
		provider: "hobo",
		option: CADENCE_OPTION,
		config: Object.freeze({ cron: expression }),
	});
}

export function readCadence(
	annotations: readonly ProviderAnnotation[],
): string | undefined {
	const found = annotations.find(
		(annotation) => annotation.option === CADENCE_OPTION,
	);
	if (found === undefined || !isJsonObject(found.config)) return undefined;
	const cron = found.config.cron;
	return isJsonString(cron) && CRON.test(cron) ? cron : undefined;
}

export type CadenceViolation = Readonly<{
	code: "CADENCE_ON_NON_SCHEDULE" | "CADENCE_WITHOUT_TARGET";
	resource: string;
	message: string;
}>;

export function cadenceViolations(
	definition: BindleDefinition,
): readonly CadenceViolation[] {
	return Object.freeze(
		Object.values(definition.resources).flatMap(
			(resource): readonly CadenceViolation[] => {
				if (readCadence(resource.annotations) === undefined) return [];
				if (resource.kind !== "schedule")
					return [
						Object.freeze({
							code: "CADENCE_ON_NON_SCHEDULE" as const,
							resource: resource.name,
							message: `${resource.name} is a ${resource.kind}; only a schedule runs on a cadence.`,
						}),
					];
				const targets = definition.edges.filter(
					(edge) => edge.from === resource.name,
				);
				return targets.length === 1
					? []
					: [
							Object.freeze({
								code: "CADENCE_WITHOUT_TARGET" as const,
								resource: resource.name,
								message: `${resource.name} runs on a cadence and must depend on exactly the one resource it runs; it depends on ${targets.length}.`,
							}),
						];
			},
		),
	);
}
