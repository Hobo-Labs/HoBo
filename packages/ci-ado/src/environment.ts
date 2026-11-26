import type { ParsedPipeline, PipelineResult } from "@hobo/ci/execution";
import { parseEnvironmentName } from "./project.js";

/** Only declared names cross from the host into check processes. */
export function resolveEnvironment(
	refs: Readonly<Record<string, string>>,
	pipeline: ParsedPipeline,
	host: NodeJS.ProcessEnv,
): Record<string, string> {
	const resolved = new Map<string, string>();
	for (const [target, source] of Object.entries(refs)) {
		parseEnvironmentName(target);
		parseEnvironmentName(source);
		if (target.startsWith("HOBO_CI_") || source.startsWith("HOBO_CI_"))
			throw new Error("HoBo CI metadata cannot be rebound");
		const value = Object.hasOwn(host, source) ? host[source] : undefined;
		if (
			!value ||
			value === `$(${source})` ||
			value.includes("\0") ||
			value.length > 65536
		)
			throw new Error(`missing or invalid environment reference: ${source}`);
		if (pipeline.steps.some((step) => Object.hasOwn(step.env, target)))
			throw new Error(
				`environment reference conflicts with step literal: ${target}`,
			);
		resolved.set(target, value);
	}
	return Object.fromEntries(resolved);
}

/** Exact declared values are removed from logs; this is not a data-loss-prevention filter. */
export function redactResult(
	result: PipelineResult,
	values: readonly string[],
): PipelineResult {
	const ordered = [...new Set(values)]
		.filter(Boolean)
		.sort((a, b) => b.length - a.length);
	const mask = (text: string) => {
		for (const value of ordered) text = text.replaceAll(value, "***");
		return text;
	};
	return {
		...result,
		error: mask(result.error),
		steps: result.steps.map((step) => ({
			...step,
			stdout: mask(step.stdout),
			stderr: mask(step.stderr),
		})),
	};
}
