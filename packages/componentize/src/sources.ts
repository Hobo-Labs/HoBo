import { build } from "esbuild";

export async function bundleTypeScriptEntry(entryPath: string) {
	const result = await build({
		entryPoints: [entryPath],
		bundle: true,
		format: "esm",
		legalComments: "none",
		minifyWhitespace: true,
		platform: "neutral",
		target: "es2022",
		write: false,
	});
	const output = result.outputFiles[0];
	if (!output) {
		throw new Error("componentize.real.missing_bundle_output");
	}
	return output.text.replaceAll("\r\n", "\n");
}
