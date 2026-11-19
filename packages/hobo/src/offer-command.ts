import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CommandModule, YardRuntime } from "@hobo/cli";
import { loadBindleDefinition } from "@hobo/cli";
import { assertOfferIsSecretFree, buildDeploymentOffer } from "@hobo/recipes";
import { defaultHoboHome } from "./bare-metal-yard.js";
import { isJsonNumber, isJsonString, type JsonObject } from "./json.js";
import {
	buildRecipeContext,
	compileTopology,
	definitionsOf,
	deploymentRequestFromBindle,
	EVIDENCE_DIRECTORY,
	isAcceptedCompilation,
	RecipePlaneError,
	requireRecipe,
	type SolutionRecipe,
} from "./recipe-plane.js";

export interface OfferCommandDeps {
	readonly runtime: YardRuntime;
	readonly now?: () => number;
}

function localOfferSigner(home: string) {
	const keyId = `hobo-local:${createHash("sha256").update(home).digest("hex").slice(0, 16)}`;
	return {
		algorithm: "hmac-sha256",
		keyId,
		sign(payloadDigest: string): string {
			return createHash("sha256")
				.update(keyId)
				.update(payloadDigest)
				.digest("hex");
		},
	};
}

export function createOfferCommand(deps: OfferCommandDeps): CommandModule {
	const now = deps.now ?? (() => Date.now());

	return {
		run: async ({ args, flags, context }) => {
			const recipeId = args[0];
			if (recipeId === undefined) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_OFFER_USAGE",
					message: "hobo offer <recipe-id>",
					remediation: [
						"Run `hobo recipes list` to see registered recipe ids.",
					],
				};
			}

			const projectDir =
				(isJsonString(flags.cwd) && flags.cwd.length > 0
					? flags.cwd
					: undefined) ??
				(context as { projectDir?: string }).projectDir ??
				context.cwd;
			const home =
				isJsonString(flags.home) && flags.home.length > 0
					? flags.home
					: defaultHoboHome();
			const atFlag = (flags as JsonObject).at;
			const nowMs = isJsonNumber(atFlag) ? atFlag : now();

			let recipe: SolutionRecipe;
			try {
				recipe = requireRecipe(recipeId);
			} catch (error) {
				if (error instanceof RecipePlaneError) {
					return {
						ok: false,
						status: "unknown-recipe",
						code: "HOBO_OFFER_UNKNOWN_RECIPE",
						message: error.message,
						remediation: [
							"Run `hobo recipes list` to see registered recipe ids.",
						],
					};
				}
				throw error;
			}

			const bindle = await loadBindleDefinition(projectDir);
			if (bindle === null) {
				return {
					ok: false,
					status: "no-bindle",
					code: "HOBO_OFFER_NO_BINDLE",
					message: `hobo offer: no Bindle source found in ${projectDir}`,
					remediation: [
						"Run `hobo new` to scaffold a project, or run from a directory with a bindle source.",
					],
				};
			}

			const request = deploymentRequestFromBindle(
				bindle,
				bindle.name,
				recipe.delivers,
			);

			const context_ = await buildRecipeContext({
				definitions: definitionsOf(deps.runtime),
				evidenceDirectory: join(home, EVIDENCE_DIRECTORY),
				home,
			});

			const compilation = compileTopology({
				recipe,
				request,
				context: context_,
				nowMs,
			});

			if (!isAcceptedCompilation(compilation)) {
				return {
					ok: false,
					status: "rejected",
					code: "HOBO_OFFER_REJECTED",
					message: `hobo offer ${recipe.id}: ${compilation.rejections.length} blocking rejection(s)`,
					remediation: compilation.rejections.map(
						(rejection) => `${rejection.code}: ${rejection.detail}`,
					),
					data: {
						command: "offer",
						recipeId: recipe.id,
						rejections: compilation.rejections,
						catalogDigest: context_.catalog.catalogDigest,
						evidenceCount: context_.evidence.length,
					},
				};
			}

			const offer = buildDeploymentOffer({
				compilation,
				recipe,
				request,
				catalogDigest: context_.catalog.catalogDigest,
				profileRegistryDigest: context_.profileRegistryDigest,
				issuedAtMs: nowMs,
				signer: localOfferSigner(home),
			});

			assertOfferIsSecretFree(offer);

			return {
				ok: true,
				status: "offered",
				code: "HOBO_OFFER_COMPILED",
				message: `hobo offer ${recipe.id}: ${offer.claimSummary.actionCount} claim action(s) across ${offer.providers.length} provider(s)`,
				data: { command: "offer", offer },
			};
		},
	};
}
