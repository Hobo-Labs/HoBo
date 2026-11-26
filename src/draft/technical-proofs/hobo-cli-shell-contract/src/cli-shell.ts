import { access } from "node:fs/promises";
import path from "node:path";

export const CANONICAL_VERBS = [
  { name: "up", role: "lifecycle", summary: "Realize the current object graph" },
  { name: "down", role: "lifecycle", summary: "Tear down what up realized" },
  { name: "dev", role: "local loop", summary: "Run against runtime-local" },
  { name: "new", role: "local loop", summary: "Scaffold a runnable SDK program" },
  { name: "login", role: "identity", summary: "Obtain a dev SVID through OIDC" },
  { name: "claim", role: "identity", summary: "Bind an anonymous deployment to an account" },
  { name: "plan", role: "read-only", summary: "Dry-run the up decision" },
  { name: "verify", role: "read-only", summary: "Run the unified Gatekeeper preflight" },
  { name: "can-deploy", role: "read-only", summary: "Diagnose producer/consumer compatibility" },
  { name: "inspect", role: "read-only", summary: "Render projections and time-travel views" },
  { name: "logs", role: "read-only", summary: "Live-tail Camp runtime streams" },
  { name: "doctor", role: "diagnostics", summary: "Report environment and portability hazards" },
  { name: "codegen", role: "authoring", summary: "Regenerate checked-in generated clients" },
  { name: "build", role: "authoring", summary: "Compile services to wasm components" },
  { name: "collect", role: "authoring", summary: "Run resource collection and print manifest IR" },
  { name: "stub", role: "authoring", summary: "Run with a contract-backed stub" },
  { name: "drift", role: "diagnostics", summary: "Report drift and governed remediation paths" },
  { name: "add", role: "distribution", summary: "Install a provider or listing" },
  { name: "registry", role: "distribution", summary: "Administer registry artifacts" },
  { name: "import", role: "migration", summary: "Adopt existing estate in place" },
  { name: "generate", role: "generation", summary: "Request provider generation" },
  { name: "sandbox", role: "test loop", summary: "Run a contract-backed isolated lane" },
  { name: "test", role: "test loop", summary: "Alias for the sandbox test lane" },
  { name: "attest", role: "governance", summary: "Produce signed external evidence exports" },
  { name: "erase", role: "governance", summary: "Request crypto-shred erasure" },
  { name: "derivative", role: "extensibility", summary: "Manage derived HoBo implementations" },
  { name: "runbook", role: "SRE", summary: "Execute or replay incident runbooks" }
];

export const GLOBAL_FLAGS = [
  "--json",
  "--camp <camp>",
  "--cwd <path>",
  "--verbose",
  "-q",
  "--help"
];

export const CLI_COMMAND_SCHEMAS = Object.freeze(
  Object.fromEntries(CANONICAL_VERBS.map((verb) => [verb.name, cliCommandSchemaFor(verb.name)])),
);

const verbNames = new Set(CANONICAL_VERBS.map((verb) => verb.name));
const projectScopedVerbs = new Set(
  CANONICAL_VERBS.map((verb) => verb.name).filter((verb) => !["new", "login", "claim", "add", "registry", "generate", "derivative"].includes(verb))
);
const markers = ["hobo.bindle.json", "bindle.ts", "bindle.js", ".hobo"];

class CliError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

class UsageError extends CliError {
  constructor(message) {
    super(message, 2);
  }
}

class NoBindleError extends CliError {
  constructor(cwd) {
    super(`No Bindle here: ${cwd}\nRun from a HoBo project or pass --cwd <path> to one.`, 1);
  }
}

export function helpText() {
  const verbRows = CANONICAL_VERBS.map(
    (verb) => `  ${verb.name.padEnd(12)}${verb.role.padEnd(14)}${verb.summary}`
  ).join("\n");

  return `HoBo CLI

Usage:
  hobo [global flags] <verb> [args]
  hobo --help
  hobo <verb> --help

Global flags:
  --json          Emit a machine-readable JSON envelope on stdout
  --camp <camp>   Select the target Camp
  --cwd <path>    Resolve the HoBo project from this directory
  --verbose       Print detailed diagnostics on stderr
  -q              Suppress non-error human output
  --help          Show help

Canonical verbs:
${verbRows}
`;
}

export function verbHelpText(verbName) {
  const verb = CANONICAL_VERBS.find((candidate) => candidate.name === verbName);
  if (!verb) {
    throw new UsageError(unknownVerbMessage(verbName));
  }

  return `HoBo ${verb.name}

Usage:
  hobo ${verb.name} [global flags] [args]

Role: ${verb.role}
Status: not yet implemented

This shell dispatches ${verb.name} through the shared command registry. The verb behavior is intentionally stubbed in HOBO-115.
`;
}

export function createHoboCli(options = {}) {
  const commands = createCommandRegistry(options.commands ?? {});
  const contextFactory = options.contextFactory ?? defaultContextFactory;

  return {
    async run(argv, runOptions = {}) {
      try {
        const request = parseArgv(argv, runOptions);

        if (request.help && !request.verb) {
          return okText(helpText());
        }

        if (!request.verb) {
          return okText(helpText());
        }

        if (!verbNames.has(request.verb)) {
          throw new UsageError(unknownVerbMessage(request.verb));
        }

        if (request.help) {
          return okText(verbHelpText(request.verb));
        }

        const command = commands.get(request.verb);
        const context = await contextFactory({
          cwd: request.cwd,
          env: runOptions.env ?? process.env,
          flags: request.flags,
          verb: request.verb,
          args: request.args,
          requiresProject: projectScopedVerbs.has(request.verb)
        });
        const result = await command.run({
          context,
          flags: request.flags,
          args: request.args,
          verb: request.verb,
          emitProgress: runOptions.onProgress ?? (() => {}),
        });

        return renderSuccess({ verb: request.verb, flags: request.flags, context, result });
      } catch (error) {
        return renderError(error);
      }
    }
  };
}

export async function runHobo(argv, options = {}) {
  return createHoboCli().run(argv, options);
}

function createCommandRegistry(overrides) {
  const registry = new Map();
  for (const verb of CANONICAL_VERBS) {
    registry.set(verb.name, {
      run: async () => ({
        ok: true,
        status: "not_implemented",
        code: "HOBO_CLI_STUB",
        message: `${verb.name} is not yet implemented`,
        data: {}
      })
    });
  }

  for (const [name, command] of Object.entries(overrides)) {
    if (!verbNames.has(name)) {
      throw new UsageError(`Cannot register unknown HoBo verb "${name}".`);
    }
    registry.set(name, command);
  }

  return registry;
}

function parseArgv(argv, options) {
  const flags = {
    json: false,
    camp: null,
    cwd: path.resolve(options.cwd ?? process.cwd()),
    verbose: false,
    quiet: false,
    help: false,
    to: null,
    rollback: false,
    seed: false,
    restore: null,
    strategy: null,
    target: null,
    check: false,
    last: false,
    offline: false
  };
  const args = [];
  let verb = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--") {
      args.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith("-")) {
      index = parseOption(argv, index, flags, verb);
      continue;
    }

    if (!verb) {
      verb = token;
      continue;
    }

    args.push(token);
  }

  if (flags.to && flags.rollback) {
    throw new UsageError('--to cannot be combined with --rollback. Use one revision selector for "hobo up".');
  }

  return {
    verb,
    args,
    cwd: flags.cwd,
    help: flags.help,
    flags
  };
}

function parseOption(argv, index, flags, verb) {
  const token = argv[index];

  switch (token) {
    case "--json":
      flags.json = true;
      return index;
    case "--camp":
      flags.camp = takeValue(argv, index, token);
      return index + 1;
    case "--cwd":
      flags.cwd = path.resolve(takeValue(argv, index, token));
      return index + 1;
    case "--verbose":
      flags.verbose = true;
      return index;
    case "-q":
      flags.quiet = true;
      return index;
    case "--help":
    case "-h":
      flags.help = true;
      return index;
    case "--to":
      flags.to = takeValue(argv, index, token);
      return index + 1;
    case "--rollback":
      flags.rollback = true;
      return index;
    case "--seed":
      flags.seed = true;
      return index;
    case "--restore":
      flags.restore = takeValue(argv, index, token);
      return index + 1;
    case "--strategy":
      flags.strategy = takeValue(argv, index, token);
      return index + 1;
    case "--target":
      flags.target = takeValue(argv, index, token);
      return index + 1;
    case "--check":
      flags.check = true;
      return index;
    case "--last":
      flags.last = true;
      return index;
    case "--offline":
      if (verb === "doctor") {
        flags.offline = true;
        return index;
      }
      throw new UsageError(`Unknown option "${token}". Run "${verb ? `hobo ${verb} --help` : "hobo --help"}".`);
    default:
      throw new UsageError(`Unknown option "${token}". Run "${verb ? `hobo ${verb} --help` : "hobo --help"}".`);
  }
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new UsageError(`Option "${flag}" requires a value.`);
  }
  return value;
}

async function defaultContextFactory(request) {
  const projectDir = await findProjectDir(request.cwd);
  if (request.requiresProject && !projectDir) {
    throw new NoBindleError(request.cwd);
  }

  return {
    cwd: request.cwd,
    projectDir,
    identity: null,
    clients: {
      readApi: "stub",
      runtime: "stub"
    }
  };
}

async function findProjectDir(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    for (const marker of markers) {
      if (await exists(path.join(current, marker))) {
        return current;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function renderSuccess({ verb, flags, context, result }) {
  const envelope = {
    ok: result.ok !== false,
    verb,
    status: result.status ?? "ok",
    code: result.code ?? "HOBO_OK",
    message: result.message ?? "",
    context: publicContext(context),
    data: result.data ?? {}
  };
  const exitCode = envelope.ok ? 0 : 1;

  if (flags.json) {
    return okText(`${JSON.stringify(envelope)}\n`, exitCode);
  }

  if (flags.quiet) {
    return okText("", exitCode);
  }

  return okText(`Command  Status
${verb.padEnd(8)} ${envelope.status}

${envelope.message}
`, exitCode);
}

function renderError(error) {
  if (error instanceof CliError) {
    return {
      exitCode: error.exitCode,
      stdout: "",
      stderr: `${error.message}\n`
    };
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: "Internal CLI error. Re-run with --verbose for diagnostics.\n"
  };
}

function okText(stdout, exitCode = 0) {
  return {
    exitCode,
    stdout,
    stderr: ""
  };
}

function cliCommandSchemaFor(verbName) {
  switch (verbName) {
    case "inspect":
    case "logs":
      return objectSchema({ runId: { type: "string" } }, ["runId"]);
    case "registry":
      return objectSchema({ capability: { type: "string" } }, ["capability"]);
    default:
      return objectSchema({
        cwd: { type: "string" },
        camp: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      });
  }
}

function objectSchema(properties = {}, required = []) {
  return Object.freeze({
    type: "object",
    properties,
    required,
    additionalProperties: true,
  });
}

function publicContext(context) {
  return {
    cwd: context.cwd,
    projectDir: context.projectDir,
    identity: context.identity ?? null,
    clients: context.clients
  };
}

function unknownVerbMessage(input) {
  const suggestion = nearestVerb(input);
  return `Unknown verb "${input}".${suggestion ? ` Did you mean "${suggestion}"?` : ""} Run "hobo --help".`;
}

function nearestVerb(input) {
  let best = null;
  for (const candidate of CANONICAL_VERBS.map((verb) => verb.name)) {
    const distance = levenshtein(input, candidate);
    if (!best || distance < best.distance) {
      best = { candidate, distance };
    }
  }

  return best && best.distance <= Math.max(2, Math.floor(input.length / 2)) ? best.candidate : null;
}

function levenshtein(left, right) {
  const distances = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let row = 0; row <= left.length; row += 1) {
    distances[row][0] = row;
  }
  for (let column = 0; column <= right.length; column += 1) {
    distances[0][column] = column;
  }

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      distances[row][column] = Math.min(
        distances[row - 1][column] + 1,
        distances[row][column - 1] + 1,
        distances[row - 1][column - 1] + substitutionCost
      );
    }
  }

  return distances[left.length][right.length];
}
