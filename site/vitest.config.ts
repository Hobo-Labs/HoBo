import { defineConfig } from "vitest/config";

// NATIVE node loader (tsx registered once in catalog.ts), not vite's
// transform: vite/oxc refuses to lower todo-api's stage-3 @trainable
export default defineConfig({
	test: {
		testTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 10_000),
		hookTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 10_000),
		server: {
			deps: {
				external: [
					/examples\/try-site\/apps\//u,
					// Keep the 9 MB CJS compiler on Node's native loader. Vite otherwise
					/\/node_modules\/(?:.*\/)?typescript\/lib\/typescript\.js$/,
				],
			},
		},
	},
});
