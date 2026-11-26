/**
 * Generate the Examples console's recipe-terms artifact.
 *
 * The console has to tell a visitor what a deploy will cost them before they
 * press the button: which providers get involved, how many ownership
 * ceremonies they inherit, how long they have to complete them, and who holds
 * the credentials in the meantime. Those are not marketing facts to be written
 * by hand — they are fields on the shipped `SolutionRecipe`s.
 *
 * So this script derives them. Nothing about a recipe can be described
 * differently on the site than it is in `@hobo/recipes`, because the site
 * never gets a chance to say it in its own words. `recipe-terms.test.ts`
 * re-runs the derivation and fails on drift, the same gate the CLI's
 * agent-docs surface uses.
 *
 *   pnpm --filter hobo-site run generate:recipe-terms
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveRecipeTerms } from "../src/lib/examples/recipe-terms-source.js";

const OUTPUT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"lib",
	"examples",
	"recipe-terms.json",
);

await writeFile(OUTPUT, `${JSON.stringify(deriveRecipeTerms(), null, "\t")}\n`);
console.log(`wrote ${OUTPUT}`);
