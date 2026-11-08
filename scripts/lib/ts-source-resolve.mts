/**
 * Let `node --experimental-strip-types` load workspace TypeScript sources that
 * use NodeNext `.js` specifiers for sibling `.ts` files, without tsx. Jobs that
 * run before (or without) `pnpm install` have no node_modules to resolve tsx
 * from. Node builtins only.
 *
 * Usage: `node --experimental-strip-types --import ./scripts/lib/ts-source-resolve.mts …`
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				error.code !== "ERR_MODULE_NOT_FOUND" ||
				!specifier.startsWith(".") ||
				!specifier.endsWith(".js") ||
				!context.parentURL?.startsWith("file:")
			)
				throw error;
			const source = new URL(
				`${specifier.slice(0, -".js".length)}.ts`,
				context.parentURL,
			);
			if (!existsSync(fileURLToPath(source))) throw error;
			return nextResolve(source.href, context);
		}
	},
});
