import { defineConfig } from "vitest/config";

// Catalog app modules (examples/try-site/apps/*/app.ts) load through the
// NATIVE node loader (tsx registered once in catalog.ts), not vite's
// transform: vite/oxc refuses to lower todo-api's stage-3 @trainable
// decorator, so a transformed import dies on `@` at parse time. Marking the
// apps external keeps the runner's hands off those dynamic imports.
export default defineConfig({
	test: {
		// Native app loading can compile TypeScript. Honor the same bounded
		// timeout override as the repository's owning-package test lanes.
		testTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 10_000),
		hookTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 10_000),
		server: {
			deps: {
				external: [
					/examples\/try-site\/apps\//u,
					// Keep the 9 MB CJS compiler on Node's native loader. Vite otherwise
					// inlines and transforms it for the catalog's trainable scanner.
					/\/node_modules\/(?:.*\/)?typescript\/lib\/typescript\.js$/,
				],
			},
		},
	},
});
