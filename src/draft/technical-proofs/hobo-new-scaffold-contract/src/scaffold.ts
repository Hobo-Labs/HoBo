import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isJsonString } from "./json.js";

export const VALID_TEMPLATES = ["todo", "api", "agent", "fullstack"];

const createdFileOrder = [
  ".gitignore",
  "app.test.ts",
  "app.ts",
  "hobo.bindle.json",
  "package.json",
  "src/_generated/hobo.d.ts",
  "src/_generated/index.ts",
  "tsconfig.json"
];

const reservedWindowsNames = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9"
]);

class ScaffoldCliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

export class TemplateError extends ScaffoldCliError {}
export class ProjectNameError extends ScaffoldCliError {}
export class DestinationExistsError extends ScaffoldCliError {}

export async function runHoboNew(argv, options = {}) {
  try {
    const request = parseNewArgs(argv);
    const result = await scaffoldHoboProject({
      cwd: options.cwd ?? process.cwd(),
      name: request.name,
      template: request.template,
      force: request.force,
      network: options.network
    });

    const nextSteps = [`cd ${request.name}`, "hobo dev"];
    if (request.json) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ok: true,
          command: "new",
          name: request.name,
          template: result.template,
          projectDir: result.projectDir,
          createdFiles: result.createdFiles,
          nextSteps,
          offline: true
        }),
        stderr: ""
      };
    }

    return {
      exitCode: 0,
      stdout: `Created HoBo project ${request.name}\n\n${nextSteps.join("\n")}\n`,
      stderr: ""
    };
  } catch (error) {
    return {
      exitCode: error.exitCode ?? 1,
      stdout: "",
      stderr: `${error.message}\n`
    };
  }
}

export async function scaffoldHoboProject({ cwd, name, template = "api", force = false } = {}) {
  const safeName = validateProjectName(name);
  const safeTemplate = validateTemplate(template);
  const projectDir = path.resolve(cwd ?? process.cwd(), safeName);
  const existing = await existingDirectory(projectDir);

  if (existing.exists && !existing.isDirectory) {
    throw new DestinationExistsError(`${projectDir} already exists and is not a directory.`);
  }

  if (existing.exists && existing.entries.length > 0 && !force) {
    throw new DestinationExistsError(
      `${projectDir} already exists and is not empty. Use --force to write HoBo scaffold files without deleting unrelated files.`
    );
  }

  await mkdir(path.join(projectDir, "src/_generated"), { recursive: true });

  const files = buildProjectFiles({ name: safeName, template: safeTemplate });
  for (const relativePath of createdFileOrder) {
    await writeOwnedFile(projectDir, relativePath, files.get(relativePath));
  }

  return {
    projectDir,
    name: safeName,
    template: safeTemplate,
    createdFiles: [...createdFileOrder],
    offline: true
  };
}

export async function validateScaffoldProject(projectDir) {
  const missing = [];
  for (const relativePath of createdFileOrder) {
    try {
      await stat(path.join(projectDir, relativePath));
    } catch {
      missing.push(relativePath);
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      canRunHoboDev: false,
      typecheck: { status: "fail", reason: "missing scaffold files" },
      tests: { status: "fail", reason: "missing scaffold files" }
    };
  }

  const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf8"));
  const bindle = JSON.parse(await readFile(path.join(projectDir, "hobo.bindle.json"), "utf8"));
  const app = await readFile(path.join(projectDir, "app.ts"), "utf8");
  const appTest = await readFile(path.join(projectDir, "app.test.ts"), "utf8");
  const generated = await readFile(path.join(projectDir, "src/_generated/index.ts"), "utf8");
  const declarations = await readFile(path.join(projectDir, "src/_generated/hobo.d.ts"), "utf8");
  const gitignore = await readFile(path.join(projectDir, ".gitignore"), "utf8");

  const violations = [];
  if (packageJson.scripts?.dev !== "hobo dev") {
    violations.push("package.json must expose hobo dev");
  }
  if (packageJson.scripts?.test !== "node --test") {
    violations.push("package.json must expose node --test");
  }
  if (packageJson.scripts?.typecheck !== "tsc --noEmit") {
    violations.push("package.json must expose tsc --noEmit");
  }
  if (!VALID_TEMPLATES.includes(bindle.template)) {
    violations.push("bindle template must be one of the valid templates");
  }
  if (!app.includes(`template: "${bindle.template}"`)) {
    violations.push("app.ts must pin the selected template");
  }
  if (!app.includes("export const api = hobo.api")) {
    violations.push("app.ts must export an api handler");
  }
  if (!app.includes("export const resource = hobo.resource")) {
    violations.push("app.ts must export a resource");
  }
  if (!app.includes('from "./src/_generated/index.js"')) {
    violations.push("app.ts must consume checked-in generated bindings");
  }
  if (!appTest.includes("createTestRuntime")) {
    violations.push("app.test.ts must exercise the generated test runtime");
  }
  if (!generated.includes("generated hobo new bindings seed")) {
    violations.push("generated seed must be checked in");
  }
  if (!declarations.includes('declare module "@hobo/sdk"')) {
    violations.push("declarations must seed SDK module types");
  }
  if (!/^\.hobo\/$/m.test(gitignore)) {
    violations.push(".gitignore must ignore .hobo/");
  }
  if (/fetch\(|registry|templateUrl|http:|https:/i.test(`${app}\n${generated}\n${declarations}`)) {
    violations.push("scaffold must not depend on registry-hosted or network templates");
  }

  return {
    ok: violations.length === 0,
    template: bindle.template,
    canRunHoboDev: packageJson.scripts?.dev === "hobo dev",
    missing,
    violations,
    typecheck: {
      status: violations.length === 0 ? "pass" : "fail",
      mode: "static-contract"
    },
    tests: {
      status: violations.length === 0 ? "pass" : "fail",
      mode: "generated-test-runtime-contract"
    }
  };
}

function parseNewArgs(argv) {
  const request = {
    name: null,
    template: "api",
    json: false,
    force: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    switch (token) {
      case "--json":
        request.json = true;
        break;
      case "--force":
        request.force = true;
        break;
      case "-t":
      case "--template":
        request.template = takeValue(argv, index, token);
        index += 1;
        break;
      default:
        if (token.startsWith("-")) {
          throw new ScaffoldCliError(`Unknown option "${token}". Run "hobo new --help" for usage.`);
        }
        if (request.name !== null) {
          throw new ScaffoldCliError(`Unexpected argument "${token}". hobo new accepts exactly one project name.`);
        }
        request.name = token;
        break;
    }
  }

  if (request.name === null) {
    throw new ProjectNameError("Invalid project name: provide a directory name for hobo new.");
  }

  validateProjectName(request.name);
  validateTemplate(request.template);
  return request;
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new ScaffoldCliError(`${flag} requires a value.`);
  }
  return value;
}

function validateTemplate(template) {
  if (!VALID_TEMPLATES.includes(template)) {
    throw new TemplateError(`Unknown template "${template}". Valid templates: ${VALID_TEMPLATES.join(", ")}.`);
  }
  return template;
}

function validateProjectName(name) {
  if (!isJsonString(name) || name.trim() === "") {
    throw new ProjectNameError("Invalid project name: project name cannot be empty.");
  }
  if (name !== name.trim()) {
    throw new ProjectNameError(`Invalid project name "${name}": leading and trailing spaces are not allowed.`);
  }
  if (name === "." || name === ".." || name.includes("..")) {
    throw new ProjectNameError(`Invalid project name "${name}": parent directory traversal is not allowed.`);
  }
  if (/[\\/:*?"<>|]/.test(name)) {
    throw new ProjectNameError(`Invalid project name "${name}": path separators and reserved characters are not allowed.`);
  }
  const base = name.replace(/\..*$/, "").toUpperCase();
  if (reservedWindowsNames.has(base)) {
    throw new ProjectNameError(`Invalid project name "${name}": reserved device names are not allowed.`);
  }
  return name;
}

async function existingDirectory(projectDir) {
  try {
    const info = await stat(projectDir);
    return {
      exists: true,
      isDirectory: info.isDirectory(),
      entries: info.isDirectory() ? await readdir(projectDir) : []
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, isDirectory: false, entries: [] };
    }
    throw error;
  }
}

async function writeOwnedFile(root, relativePath, content) {
  await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });

  if (relativePath === ".gitignore") {
    await mergeGitignore(path.join(root, relativePath), content);
    return;
  }

  await writeFile(path.join(root, relativePath), content);
}

async function mergeGitignore(filePath, requiredContent) {
  const requiredLines = requiredContent.trimEnd().split("\n");
  let current = "";
  try {
    current = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const currentLines = current.trimEnd() === "" ? [] : current.trimEnd().split(/\r?\n/);
  const mergedLines = [...currentLines];
  for (const line of requiredLines) {
    if (!mergedLines.includes(line)) {
      mergedLines.push(line);
    }
  }

  await writeFile(filePath, `${mergedLines.join("\n")}\n`);
}

function buildProjectFiles({ name, template }) {
  return new Map([
    [".gitignore", ".hobo/\nnode_modules/\ndist/\n"],
    ["app.test.ts", appTestSource({ name, template })],
    ["app.ts", appSource({ name, template })],
    ["hobo.bindle.json", `${JSON.stringify(bindle({ name, template }), null, 2)}\n`],
    ["package.json", `${JSON.stringify(packageJson({ name }), null, 2)}\n`],
    ["src/_generated/hobo.d.ts", hoboDeclarations()],
    ["src/_generated/index.ts", generatedSource()],
    ["tsconfig.json", `${JSON.stringify(tsconfig(), null, 2)}\n`]
  ]);
}

function packageJson({ name }) {
  return {
    name,
    private: true,
    type: "module",
    scripts: {
      dev: "hobo dev",
      test: "node --test",
      typecheck: "tsc --noEmit"
    },
    devDependencies: {
      typescript: "5.5.4"
    }
  };
}

function bindle({ name, template }) {
  return {
    schemaVersion: "hobo.bindle/v1",
    name,
    template,
    entrypoint: "app.ts",
    generated: "src/_generated/index.ts",
    resources: [
      {
        name: `${template}Store`,
        kind: "kv"
      }
    ],
    handlers: [
      {
        name: "api",
        kind: "http"
      }
    ]
  };
}

function tsconfig() {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      types: []
    },
    include: ["app.ts", "app.test.ts", "src/_generated/**/*.ts"]
  };
}

function appSource({ name, template }) {
  const details = templateDetails(template);
  return `import { createHobo, create${details.runtimeName}Store } from "./src/_generated/index.js";

const hobo = createHobo({
  name: "${name}",
  template: "${template}"
});

export const resource = hobo.resource("${details.resourceName}", create${details.runtimeName}Store());

export const api = hobo.api("${details.route}", async (request) => {
  const record = await resource.put("${details.seedKey}", {
    message: "${details.message}"
  });

  return {
    status: 200,
    body: {
      template: "${template}",
      path: request.path,
      record
    }
  };
});
`;
}

function appTestSource({ name, template }) {
  const details = templateDetails(template);
  return `import { createTestRuntime } from "./src/_generated/index.js";
import { api, resource } from "./app.js";

const runtime = createTestRuntime({
  app: "${name}",
  template: "${template}"
});

await runtime.expectResource(resource, "${details.resourceName}");
await runtime.expectHandler(api, "${details.route}");
await runtime.expectResponse(api, {
  path: "${details.route}",
  body: {
    template: "${template}"
  }
});
`;
}

function generatedSource() {
  return `// generated hobo new bindings seed
// Checked in by hobo new so hobo dev can start before real codegen runs.

type Template = "todo" | "api" | "agent" | "fullstack";
type StoreValue = Record<string, string>;
type StoreRecord = { key: string; value: StoreValue };

interface Store {
  kind: string;
  put(key: string, value: StoreValue): Promise<StoreRecord>;
  get(key: string): Promise<StoreValue | null>;
}

interface Resource {
  name: string;
  store: Store;
  put(key: string, value: StoreValue): Promise<StoreRecord>;
  get(key: string): Promise<StoreValue | null>;
}

interface HandlerRequest {
  path: string;
}

interface HandlerResponse {
  status: number;
  body: {
    template: Template;
    path: string;
    [key: string]: unknown;
  };
}

interface Handler {
  route: string;
  run(request: HandlerRequest): Promise<HandlerResponse>;
}

interface Hobo {
  resource(name: string, store: Store): Resource;
  api(route: string, handler: (request: HandlerRequest) => Promise<HandlerResponse>): Handler;
}

export function createHobo(options: { name: string; template: Template }): Hobo {
  void options;

  return {
    resource(name: string, store: Store): Resource {
      return {
        name,
        store,
        put: store.put.bind(store),
        get: store.get.bind(store)
      };
    },
    api(route: string, handler: (request: HandlerRequest) => Promise<HandlerResponse>): Handler {
      return {
        route,
        run: handler
      };
    }
  };
}

export function createApiStore(): Store {
  return createMemoryStore("api");
}

export function createTodoStore(): Store {
  return createMemoryStore("todo");
}

export function createAgentStore(): Store {
  return createMemoryStore("agent");
}

export function createFullstackStore(): Store {
  return createMemoryStore("fullstack");
}

export function createTestRuntime({ app, template }: { app: string; template: Template }) {
  return {
    app,
    template,
    async expectResource(resource: Resource, name: string) {
      if (resource.name !== name) {
        throw new Error(\`Expected resource \${name}, got \${resource.name}\`);
      }
    },
    async expectHandler(handler: Handler, route: string) {
      if (handler.route !== route) {
        throw new Error(\`Expected route \${route}, got \${handler.route}\`);
      }
    },
    async expectResponse(handler: Handler, request: { path: string; body: { template: Template } }) {
      const response = await handler.run({ path: request.path });
      if (response.body.template !== request.body.template) {
        throw new Error(\`Expected template \${request.body.template}, got \${response.body.template}\`);
      }
    }
  };
}

function createMemoryStore(kind: string): Store {
  const values = new Map<string, StoreValue>();
  return {
    kind,
    async put(key: string, value: StoreValue): Promise<StoreRecord> {
      values.set(key, value);
      return { key, value };
    },
    async get(key: string): Promise<StoreValue | null> {
      return values.get(key) ?? null;
    }
  };
}
`;
}

function hoboDeclarations() {
  return `declare module "@hobo/sdk" {
  export interface HoboOptions {
    name: string;
    template: "todo" | "api" | "agent" | "fullstack";
  }

  export interface HoboRequest {
    path: string;
  }

  export interface HoboResponse {
    status: number;
    body: Record<string, unknown>;
  }

  export interface HoboResource<TStore> {
    name: string;
    store: TStore;
  }

  export interface HoboHandler {
    route: string;
    run(request: HoboRequest): Promise<HoboResponse>;
  }

  export interface Hobo {
    resource<TStore>(name: string, store: TStore): HoboResource<TStore>;
    api(route: string, handler: (request: HoboRequest) => Promise<HoboResponse>): HoboHandler;
  }

  export function createHobo(options: HoboOptions): Hobo;
}
`;
}

function templateDetails(template) {
  switch (template) {
    case "todo":
      return {
        runtimeName: "Todo",
        resourceName: "todoStore",
        route: "/todos",
        seedKey: "first-task",
        message: "Track a first HoBo task"
      };
    case "api":
      return {
        runtimeName: "Api",
        resourceName: "apiStore",
        route: "/api/hello",
        seedKey: "hello",
        message: "Hello from HoBo"
      };
    case "agent":
      return {
        runtimeName: "Agent",
        resourceName: "agentStore",
        route: "/agent/run",
        seedKey: "first-run",
        message: "Agent handler ready"
      };
    case "fullstack":
      return {
        runtimeName: "Fullstack",
        resourceName: "fullstackStore",
        route: "/app",
        seedKey: "home",
        message: "Fullstack shell ready"
      };
    default:
      throw new TemplateError(`Unknown template "${template}". Valid templates: ${VALID_TEMPLATES.join(", ")}.`);
  }
}
