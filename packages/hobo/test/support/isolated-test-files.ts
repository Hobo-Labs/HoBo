/**
 * Test files that change process-wide state: environment variables, a global
 * such as `fetch`, the working directory, or a vitest mock or spy. They keep
 * vitest's per-file module isolation. Every other hobo test file shares its
 * worker's module graph, so the CLI is composed once per worker instead of
 * once per file (about 105 s of import time across the suite).
 *
 * `test/isolated-test-files.test.ts` fails when a file starts changing that
 * state without being listed here, or stays listed after it stops.
 */
export const ISOLATED_TEST_FILES = [
	"test/auth-md-https.test.ts",
	"test/bare-metal-router.test.ts",
	"test/bare-metal-yard.test.ts",
	"test/cloudflare-deploy.test.ts",
	"test/serve-control-command.test.ts",
	"test/vercel-deploy.test.ts",
	"test/vercel-git-deploy.test.ts",
	"test/vercel-project.test.ts",
	"test/verify-command.test.ts",
];

export const PROCESS_STATE_CHANGE =
	/process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*=(?!=)|delete\s+process\.env|globalThis\.[A-Za-z_$][\w$]*\s*=(?!=)|process\.chdir\(|vi\.(?:stubEnv|stubGlobal|spyOn|mock|doMock|useFakeTimers)\(/;
