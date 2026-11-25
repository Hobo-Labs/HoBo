import { collectBindleResources } from "../../resource-collection-engine-contract/src/resource-collection-engine.js";

export const HELLO_BINDLE_ID = "hello-bindle";

export const helloBindleSourceText = `import { api, kv } from "@hobo/bindles";

export default function define(collect) {
  const todos = collect.kv("todos");
  todos.get("todo-1");
  todos.set("todo-1", { title: "hello" });

  const main = collect.api("main", { bind: { todos } });
  main.route("GET", "/todos/:id", () => todos.get("todo-1"));
  main.route("POST", "/todos", () => todos.set("todo-1", { title: "hello" }));
}
`;

export function helloBindleDefine(collect: Parameters<typeof collectBindleResources>[0]["define"]) {
  const todos = collect.kv("todos");
  todos.get("todo-1");
  todos.set("todo-1", { title: "hello" });

  const main = collect.api("main", { bind: { todos } });
  main.route("GET", "/todos/:id", () => todos.get("todo-1"));
  main.route("POST", "/todos", () => todos.set("todo-1", { title: "hello" }));
}

export function createHelloBindleCollectProject(options: { guestLanguage?: string } = {}) {
  return {
    bindleId: HELLO_BINDLE_ID,
    fileName: "bindle.ts",
    guestLanguage: options.guestLanguage ?? "ts",
    sourceText: helloBindleSourceText,
    secretRefs: [] as Array<{ name: string; ref: string; value?: string }>,
    define: helloBindleDefine,
  };
}

export const HELLO_BINDLE_MANIFEST_HASH =
  "sha256:cf9b2ce9cf6621bd747f0c2f10bfba36ac4a956ddc235ee591280d4772c5e87e";
