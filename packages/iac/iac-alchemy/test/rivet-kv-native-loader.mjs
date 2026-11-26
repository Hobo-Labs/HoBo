import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const root = new URL("../src/", import.meta.url).href;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (
			context.parentURL?.startsWith(root) &&
			specifier.startsWith(".") &&
			specifier.endsWith(".js")
		) {
			const candidate = new URL(
				`${specifier.slice(0, -3)}.ts`,
				context.parentURL,
			);
			if (existsSync(fileURLToPath(candidate)))
				return nextResolve(candidate.href, context);
		}
		return nextResolve(specifier, context);
	},
});
