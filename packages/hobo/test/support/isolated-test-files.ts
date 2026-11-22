export const ISOLATED_TEST_FILES = [
	"test/auth-md-https.test.ts",
	"test/bare-metal-mesh.test.ts",
	"test/bare-metal-yard.test.ts",
	"test/binding-delivery-startup.test.ts",
	"test/ci-relay-delivery.test.ts",
	"test/ci-relay-deploy.test.ts",
	"test/ci-relay-prebuilt.test.ts",
	"test/ci-up-relay.test.ts",
	"test/cloudflare-deploy.test.ts",
	"test/doctor-command.test.ts",
	"test/drift-command.test.ts",
	"test/evals/ceremony-explorer.eval.test.ts",
	"test/evals/mcp-store-choice.eval.test.ts",
	"test/import-command.test.ts",
	"test/local-host-environment.test.ts",
	"test/local-host-startup-failure.test.ts",
	"test/local-serve-scope.test.ts",
	"test/multi-host-startup-env.test.ts",
	"test/pinned-git-source.test.ts",
	"test/serve-control-command.test.ts",
	"test/vercel-deploy.test.ts",
	"test/vercel-git-deploy.test.ts",
	"test/vercel-project.test.ts",
	"test/verify-command.test.ts",
];

export const PROCESS_STATE_CHANGE =
	/process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\s*=(?!=)|delete\s+process\.env|globalThis\.[A-Za-z_$][\w$]*\s*=(?!=)|process\.chdir\(|vi\.(?:stubEnv|stubGlobal|spyOn|mock|doMock|useFakeTimers)\(/;
