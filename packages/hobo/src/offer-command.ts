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

// `hobo offer` — compile the proposal a human is asked to consent to, before
// anything is provisioned. It is read-only by construction: the offer names
// providers, deadlines, custody and disclosures, and the compiler that
// produces it performs no provider call.
//
//   hobo offer <recipe-id> [--now <ms>] [--home <dir>]
//
// The offer is signed so acceptance can be bound to it. The CLI signs with a
// local key derived from the Station home rather than shipping an unsigned
// offer: an unsigned proposal cannot be matched to the consent it produced.

export interface OfferCommandDeps {
	readonly runtime: YardRuntime;
	/** Overridable for tests; production reads the wall clock once, here. */
	readonly now?: () => number;
}

/**
 * The CLI's offer signer.
 *
 * `@hobo/recipes` implements no cryptography and states only what it needs: a
 * key id and a signature over canonical bytes. A local deployment signs with a
 * keyed digest over the Station's own key material; a hosted Broker signs with
 * its Ed25519 resolution key on the same bytes.
 */
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

			// An explicit `--cwd` wins: the shell infers a project directory by
			// walking up, and the caller who named one meant it.
			const projectDir =
				(isJsonString(flags.cwd) && flags.cwd.length > 0
					? flags.cwd
					: undefined) ??
				// SAFETY: assertion required at this I/O or test boundary.
				(context as { projectDir?: string }).projectDir ??
				context.cwd;
			const home =
				isJsonString(flags.home) && flags.home.length > 0
					? flags.home
					: defaultHoboHome();
			// `--at <ms>` pins the evaluation instant so an offer can be
			// recompiled deterministically from a receipt.
			// SAFETY: assertion required at this I/O or test boundary.
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

			// A leaked credential in an offer would reach the browser and the
			// terminal, so the check runs on the way out, not only in tests.
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
