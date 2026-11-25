import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		testTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 10_000),
		hookTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 10_000),
		server: {
			deps: {
				external: [
					/examples\/try-site\/apps\//u,
					/\/node_modules\/(?:.*\/)?typescript\/lib\/typescript\.js$/,
				],
			},
		},
	},
});
