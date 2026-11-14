/**
 * Retires the repository variables that used to carry routing
 * (ADR-0181, decision 6).
 *
 * Routing travels as a routing slip (`routing-slip.ts`) and committed policy
 * (`runnerRouting` in `.hobo/ci.json`); no repository variable carries it. The
 * route-table publisher that lived beside this is gone. What is left is
 * the delete: at each daemon start the slip leader sends one
 * `DELETE /repos/{r}/actions/variables/{name}` per committed
 * `runnerRouting.retiredVariables` entry.
 *
 * - 204 (deleted) and 404 (not there) are success.
 * - 403 means the App lacks "Variables: write". It is logged once for that
 *   start, naming the variables, and never retried in that process: nothing
 *   reads these variables any more, so their presence changes nothing.
 * - Anything else (a 5xx, a network failure) is logged and left for the next
 *   start. Nothing here throws.
 */
import type { GithubTransport } from "./github.js";

export type VariableRetireEvent =
	| "hobo_ci_variable_retired"
	| "hobo_ci_variable_retire_refused"
	| "hobo_ci_variable_retire_failed";

export type VariableRetireLog = (
	event: VariableRetireEvent,
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

/** What became of each name: retired (204 or 404), refused (403) or failed. */
export type VariableRetireOutcome = Readonly<{
	retired: readonly string[];
	refused: readonly string[];
	failed: readonly string[];
}>;

const NAME = /^[A-Z][A-Z0-9_]{0,99}$/u;

/**
 * Variables retired whatever the committed list says. The relay-mesh fleet
 * state variable was replaced by `@hobo/fleet` membership (ADR-0183); it is
 * no longer in the committed `retiredVariables`, so the delete lives here.
 * The name is built from parts so the retired-variable guard stays green.
 */
export const ALWAYS_RETIRED_VARIABLES: readonly string[] = [
	["HOBO", "CI", "FLEET", "STATE"].join("_"),
];

/**
 * Deletes each named repository variable once. Stops at the first 403: the
 * App will not be allowed the rest either, and the refusal is logged once,
 * with every name it leaves in place.
 */
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
		// A status when GitHub answered; the transport's message when it threw.
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
