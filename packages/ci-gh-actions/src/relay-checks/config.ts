/**
 * The `checks` block of `.hobo/ci.json` (ADR-0183): what runner-less checks a
 * repository allows. Read at the default branch, or at a pull request's base
 * branch, never at the commit a run is testing, so a branch cannot loosen its
 * own checks.
 *
 * ```json
 * { "checks": { "prTitle": { "types": ["feat", "fix"] }, "lint": true } }
 * ```
 *
 * `prTitle.types` is the title types allowed when the step names none; absent
 * means the Conventional Commits defaults. `lint` turns the lint check on; it
 * is off unless a repository says so. The block is strict: an unknown key or a
 * wrong type is a sentence the check fails with, not a silent default.
 */
import { z } from "zod";

export type RelayChecksConfig = Readonly<{
	/** Allowed title types; empty means the defaults. */
	titleTypes: readonly string[];
	/** Whether the lint check may run. */
	lint: boolean;
}>;

// public-contract: the checks a repository gets when it writes none.
export const DEFAULT_RELAY_CHECKS: RelayChecksConfig = Object.freeze({
	titleTypes: Object.freeze([]),
	lint: false,
});

const TitleType = z
	.string()
	.regex(/^[A-Za-z]{1,30}$/u, "a title type is letters only");

const ChecksBlock = z
	.object({
		prTitle: z
			.object({ types: z.array(TitleType).max(50).optional() })
			.strict()
			.optional(),
		lint: z.boolean().optional(),
	})
	.strict();

const Envelope = z.looseObject({ checks: ChecksBlock.optional() });

export type RelayChecksConfigRead =
	| Readonly<{ ok: true; config: RelayChecksConfig }>
	| Readonly<{ ok: false; problem: string }>;

function sentence(error: z.ZodError): string {
	const issue = error.issues[0];
	const path = issue?.path.join(".") ?? "";
	return `${path === "" ? "checks" : path}: ${issue?.message ?? "is not valid"}`;
}

/**
 * The `checks` block of `.hobo/ci.json`, or the sentence saying why it cannot
 * be used. A missing file or block is the defaults.
 */
export function parseRelayChecksConfig(
	json: string | undefined,
): RelayChecksConfigRead {
	if (json === undefined) return { ok: true, config: DEFAULT_RELAY_CHECKS };
	let value: z.infer<ReturnType<typeof z.json>>;
	try {
		value = z.json().parse(JSON.parse(json));
	} catch {
		return { ok: false, problem: ".hobo/ci.json is not valid JSON" };
	}
	const envelope = Envelope.safeParse(value);
	if (!envelope.success)
		return {
			ok: false,
			problem: `.hobo/ci.json is not valid at ${sentence(envelope.error)}`,
		};
	const block = envelope.data.checks;
	if (!block) return { ok: true, config: DEFAULT_RELAY_CHECKS };
	return {
		ok: true,
		config: Object.freeze({
			titleTypes: Object.freeze([...(block.prTitle?.types ?? [])]),
			lint: block.lint ?? false,
		}),
	};
}
