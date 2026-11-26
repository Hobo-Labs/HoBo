import { BuildError } from "./errors.js";
import { stableStringify } from "./events.js";
import { parseBuildRequest, type BuildRequest } from "./parse.js";
import { runBuild } from "./build.js";
import { isJsonNumber, type JsonValue } from "./json.js";


export type CliRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type HoboCli = {
  readonly run: (argv: readonly string[], runOptions?: CliRunOptions) => Promise<CliRunResult>;
};

export type CliRunOptions = {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
};

export function createBuildCli(options: { readonly execute?: typeof runBuild } = {}): HoboCli {
  const execute = options.execute ?? runBuild;

  return {
    async run(argv, runOptions = {}) {
      let request: BuildRequest = {
        json: argv.includes("--json"),
        projectRoot: runOptions.cwd ?? process.cwd(),
        targetRuntime: "auto",
        sourceDateEpoch: "2026-01-01T00:00:00.000Z",
      };

      try {
        request = parseBuildRequest(argv, runOptions.cwd ?? process.cwd(), runOptions.env ?? process.env);
        const result = await execute(request);
        return renderSuccess(request, result);
      } catch (error) {
        return renderFailure(request, error);
      }
    },
  };
}

export function registerBuildCommand(registry: {
  register(name: string, module: { run: (input: JsonValue) => Promise<JsonValue> }): void;
}): void {
  registry.register("build", {
    async run(input) {
      // SAFETY: `const request = input as BuildRequest;` is required at this I/O or test boundary.
      const request = input as BuildRequest;
      return runBuild(request);
    },
  });
}

function renderSuccess(
  request: BuildRequest,
  result: Awaited<ReturnType<typeof runBuild>>,
): CliRunResult {
  if (request.json) {
    return {
      exitCode: 0,
      stdout: stableStringify({
        ok: true,
        command: "build",
        manifest: result.manifest,
        manifestDigest: result.manifestDigest,
        runtimeTarget: request.targetRuntime,
        artifacts: result.artifacts,
      }),
      stderr: "",
    };
  }

  return {
    exitCode: 0,
    stdout: `hobo build ok (${result.artifacts.length} artifacts)\n`,
    stderr: "",
  };
}

function renderFailure(request: BuildRequest, error: JsonValue): CliRunResult {
  const contractError =
    error instanceof BuildError
      ? error
      : new BuildError("HOBO_BUILD_INTERNAL", "internal build wrapper error", {
          cause: error instanceof Error ? error.message : String(error),
        });
  const exitCode =
    isJsonNumber(contractError.detail.exitCode)
      ? contractError.detail.exitCode
      : contractError.code === "HOBO_BUILD_USAGE"
        ? 2
        : 1;

  if (request.json) {
    return {
      exitCode,
      stdout: stableStringify({
        ok: false,
        command: "build",
        code: contractError.code,
        message: contractError.message,
        detail: contractError.detail,
      }),
      stderr: "",
    };
  }

  return {
    exitCode,
    stdout: "",
    stderr: `${contractError.message}\n`,
  };
}
