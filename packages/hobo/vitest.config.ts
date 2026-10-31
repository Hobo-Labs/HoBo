import { defineConfig, mergeConfig } from "vitest/config";
import rootConfig from "../../vitest.config.js";

// PostgreSQL/TLS process acceptance has its own explicit integration lane.
export default mergeConfig(
	rootConfig,
	defineConfig({
		test: {
			isolate: true,
			include: ["test/**/*.test.ts"],
			exclude: ["e2e/**"],
			// The compile-time tests run under tsc in the same run, with the
			// tsconfig that includes them (src's tsconfig leaves test/ out), so
			// `pnpm test` fails on one that does not compile. That tsconfig also
			// takes the Vercel deploy path's test files, which compile cleanly,
			// so a type error in one of them fails the run as a source error;
			// test/ as a whole does not compile (155 errors in 26 other files).
			typecheck: {
				enabled: true,
				include: ["test/**/*.test-d.ts"],
				tsconfig: "./tsconfig.types.json",
			},
		},
	}),
);
