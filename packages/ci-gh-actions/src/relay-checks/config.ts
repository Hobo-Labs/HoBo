import { z } from "zod";

export type RelayChecksConfig = Readonly<{
	titleTypes: readonly string[];
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

export const ChecksBlock = z
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
