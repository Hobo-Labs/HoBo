/**
 * What the hosted relay ships: the functions in `api/` bundled the way a
 * bundler would, following every import through the workspace packages'
 * built output and into `node_modules`. ADR-0179 removed the relay's
 * database, so nothing PostgreSQL-shaped may be reached from any entry.
 */
import { readdirSync } from "node:fs";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const api = new URL("../api/", import.meta.url);
const entries = readdirSync(api)
	.filter((name) => name.endsWith(".ts"))
	.map((name) => new URL(name, api).pathname);

/** Every package name the bundle reached, from its inputs' paths. */
async function reachedPackages() {
	const imported = new Set<string>();
	const result = await build({
		entryPoints: entries,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node24",
		write: false,
		outdir: "out",
		metafile: true,
		logLevel: "silent",
		plugins: [
			{
				name: "record-bare-imports",
				setup(bundle) {
					bundle.onResolve({ filter: /^[^./]/ }, (args) => {
						if (!args.path.startsWith("node:")) {
							const [scope = "", name = ""] = args.path.split("/");
							imported.add(scope.startsWith("@") ? `${scope}/${name}` : scope);
						}
						return undefined;
					});
				},
			},
		],
	});
	return { imported, inputs: Object.keys(result.metafile.inputs) };
}

describe("the hosted relay's bundle", () => {
	it("reaches no PostgreSQL client, no Neon function and no data-postgres engine", async () => {
		const { imported, inputs } = await reachedPackages();
		// The bundle did follow the relay into its dependencies.
		expect(imported).toContain("@hobo/ci-gh-actions");
		expect(imported).toContain("@vercel/queue");
		for (const name of [
			"pg",
			"pg-pool",
			"@neon/functions",
			"@neondatabase/serverless",
			"@hobo/data-postgres",
			"drizzle-orm",
		])
			expect([...imported], name).not.toContain(name);
		expect(
			inputs.filter((input) =>
				/(?:^|\/)(?:pg|pg-pool|data-postgres|@neon)\//u.test(input),
			),
		).toEqual([]);
	}, 60_000);
});
