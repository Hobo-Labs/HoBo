import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function runProductionBuild(): Promise<number> {
	if (!process.env.HOBO_RELEASE_CHECKOUT_REF?.trim()) {
		process.env.HOBO_RELEASE_CHECKOUT_REF = "HEAD";
	}
	process.env.HOBO_BROWSER_WIT_FORCE_COMPONENTIZE = "1";
	const outputRoot = await mkdtemp(path.join(tmpdir(), "browser-wit-out-"));
	const { buildBrowserWitRuntime } = await import(
		"../../site/scripts/build-browser-wit-runtime.mts"
	);
	const result = await buildBrowserWitRuntime(outputRoot);
	if (result.componentDigest.length === 0) {
		process.stderr.write("buildBrowserWitRuntime returned empty digest\n");
		return 1;
	}
	process.stdout.write(`${result.componentDigest}\n`);
	return 0;
}

const code = await runProductionBuild();
process.exit(code);
