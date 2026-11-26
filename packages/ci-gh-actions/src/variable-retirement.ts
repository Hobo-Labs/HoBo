import type { GithubTransport } from "./github.js";

export type VariableRetireEvent =
	| "hobo_ci_variable_retired"
	| "hobo_ci_variable_retire_refused"
	| "hobo_ci_variable_retire_failed";

export type VariableRetireLog = (
	event: VariableRetireEvent,
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export type VariableRetireOutcome = Readonly<{
	retired: readonly string[];
	refused: readonly string[];
	failed: readonly string[];
}>;

const NAME = /^[A-Z][A-Z0-9_]{0,99}$/u;

export const ALWAYS_RETIRED_VARIABLES: readonly string[] = [
	["HOBO", "CI", "FLEET", "STATE"].join("_"),
];

export async function retireRepositoryVariables(
	github: GithubTransport,
	target: Readonly<{
		installationId: number;
		repository: string;
		names: readonly string[];
		log?: VariableRetireLog | undefined;
	}>,
): Promise<VariableRetireOutcome> {
	const retired: string[] = [];
	const failed: string[] = [];
	const names = [
		...new Set([...target.names, ...ALWAYS_RETIRED_VARIABLES]),
	].filter((name) => NAME.test(name));
	for (const [index, name] of names.entries()) {
		let status: number | undefined;
		let message: string | undefined;
		try {
			const response = await github.request(
				target.installationId,
				`/repos/${target.repository}/actions/variables/${name}`,
				"DELETE",
			);
			status = response.status;
		} catch (error) {
			message = error instanceof Error ? error.message : "unknown failure";
		}
		if (status === 204 || status === 404) {
			retired.push(name);
			target.log?.("hobo_ci_variable_retired", {
				repository: target.repository,
				variable: name,
				status,
			});
			continue;
		}
		if (status === 403) {
			const refused = names.slice(index);
			target.log?.("hobo_ci_variable_retire_refused", {
				repository: target.repository,
				variables: refused.join(","),
				status,
			});
			return { retired, refused, failed };
		}
		failed.push(name);
		target.log?.(
			"hobo_ci_variable_retire_failed",
			status === undefined
				? {
						repository: target.repository,
						variable: name,
						message: message ?? "unknown failure",
					}
				: { repository: target.repository, variable: name, status },
		);
	}
	return { retired, refused: [], failed };
}
