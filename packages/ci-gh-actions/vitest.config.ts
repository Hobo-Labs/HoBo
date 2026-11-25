import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const ISOLATED = [
	"contracts/backend-swap.consumer.test.ts",
	"contracts/local-runner.pact.test.ts",
	"test/ci-store-contract.test.ts",
	"test/pact-broker.test.ts",
];

const setup = (name: string) =>
	fileURLToPath(new URL(`./test/setup/${name}`, import.meta.url));

const common = {
	environment: "node",
	testTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 10_000),
	hookTimeout: Number(process.env.HOBO_TEST_TIMEOUT ?? 10_000),
	restoreMocks: true,
} as const;

export default defineConfig({
	test: {
		globalSetup: [setup("tmpfs-tmpdir.ts")],
		projects: [
			{
				test: { ...common, name: "isolated", isolate: true, include: ISOLATED },
			},
			{
				test: {
					...common,
					name: "shared",
					isolate: false,
					include: ["test/**/*.test.ts", "contracts/**/*.test.ts"],
					exclude: [...ISOLATED, "**/*.deep.test.ts"],
					setupFiles: [setup("no-leaked-handles.ts")],
				},
			},
		],
	},
});
