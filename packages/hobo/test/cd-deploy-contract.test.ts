/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof -- SAFETY: the PACT verifier walks the provider's JSON envelope by path; values are only checked for presence. */
// Consumer-driven contract (PACT form) for the `hobo deploy` CD envelope
// (WP18): the consumers are the MCP tool surface and scripted/agent callers;
// the provider is `runCdDeploySubcommand`. Each interaction pins the fields a
// consumer reads; the provider is verified against every interaction.
import { describe, expect, it } from "vitest";
import { runCdDeploySubcommand } from "../src/cd-deploy.js";
import {
	FREIGHT,
	fakeCd,
	host,
	promotion,
	refusal,
} from "./support/cd-fakes.js";

type Interaction = Readonly<{
	description: string;
	providerState: Parameters<typeof fakeCd>[0];
	request: Readonly<{ args: string[]; flags: Record<string, unknown> }>;
	response: Readonly<Record<string, unknown>>;
	/** Paths under `data` the consumer reads; each must be present. */
	reads: readonly string[];
}>;

// public-contract: the hobo-deploy-cd PACT (consumer: hobo-mcp/agents; provider: hobo deploy).
export const HOBO_DEPLOY_CD_PACT = Object.freeze({
	consumer: { name: "hobo-mcp" },
	provider: { name: "hobo-deploy-cd" },
	metadata: { pactSpecification: { version: "3.0.0" } },
	interactions: [
		{
			description: "a promotion request is accepted",
			providerState: {
				freight: { getByAlias: () => FREIGHT },
				promotions: { promote: () => ({ ok: true, value: promotion() }) },
			},
			request: {
				args: ["promote", "brave-otter"],
				flags: { camp: "edge/prod", format: "json" },
			},
			response: { ok: true, status: "ok", code: "HOBO_CD_PROMOTION_REQUESTED" },
			reads: [
				"command",
				"subcommand",
				"simulated",
				"promotion.promotionId",
				"promotion.state",
			],
		},
		{
			description: "a promotion is refused by lineage",
			providerState: {
				freight: { getByAlias: () => FREIGHT },
				promotions: {
					promote: () =>
						refusal("lineage-unsatisfied", "Qualify upstream first."),
				},
			},
			request: {
				args: ["promote", "brave-otter"],
				flags: { camp: "edge/prod", format: "json" },
			},
			response: { ok: false, status: "refused", code: "lineage-unsatisfied" },
			reads: [
				"command",
				"subcommand",
				"reasons.0.code",
				"reasons.0.remediation",
			],
		},
		{
			description: "an unknown subcommand is a usage error with next steps",
			providerState: {},
			request: { args: ["freight", "explode"], flags: {} },
			response: { ok: false, status: "usage", code: "HOBO_DEPLOY_USAGE" },
			reads: ["command", "subcommand"],
		},
	] satisfies Interaction[],
});

function at(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((v, key) => {
		if (v === null || typeof v !== "object") return undefined;
		return (v as Record<string, unknown>)[key];
	}, value);
}

describe("PACT hobo-mcp → hobo-deploy-cd", () => {
	for (const interaction of HOBO_DEPLOY_CD_PACT.interactions) {
		it(interaction.description, async () => {
			const out = await runCdDeploySubcommand(
				host(fakeCd(interaction.providerState)),
				interaction.request.args,
				interaction.request.flags,
			);
			expect(out).toMatchObject(interaction.response);
			for (const path of interaction.reads)
				expect(at(out.data, path), path).not.toBeUndefined();
			if (out.ok === false) expect(out.remediation?.length).toBeGreaterThan(0);
		});
	}
});
