import { readFile, writeFile } from "node:fs/promises";
import { ciProjectProvidersJsonSchema } from "../src/project-providers.js";
import { ciProjectJsonSchema } from "../src/project-schema.js";

const outputs = [
	["../schema/ci-project.schema.json", ciProjectJsonSchema()],
	[
		"../schema/ci-project-providers.schema.json",
		ciProjectProvidersJsonSchema(),
	],
] as const;
for (const [file, schema] of outputs) {
	const path = new URL(file, import.meta.url);
	const generated = `${JSON.stringify(schema, null, 2)}\n`;
	if (process.argv.includes("--check")) {
		if ((await readFile(path, "utf8").catch(() => "")) !== generated)
			throw new Error("CI project schema is stale; run schema:generate");
	} else await writeFile(path, generated);
}
