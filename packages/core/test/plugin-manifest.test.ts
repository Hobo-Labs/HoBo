/**
 * Cases live in `plugin-manifest.cases.jsonl`.
 *
 * A plugin manifest is third-party input, so the refusals are the surface worth
 * covering — and `describeConcern` fails if the module grows a parser with no
 * cases.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeConcern } from "@hobo/contract-harness";

import * as pluginManifest from "../src/plugin-manifest.js";

describeConcern("plugin manifest", {
	subject: () => pluginManifest,
	cases: path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"plugin-manifest.cases.jsonl",
	),
	uncovered: {
		PluginManifestParseError:
			"an error type, asserted by the throwsSubset cases rather than called",
	},
});
