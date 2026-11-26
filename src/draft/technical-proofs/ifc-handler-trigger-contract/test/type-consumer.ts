import { api, kv, queue } from "../src/ifc-handler-trigger-contract.js";
import { type JsonValue } from "../src/json.js";


async function assertHandlerContextTypes() {
  const todos = kv("todos");
  const orders = queue("orders");
  const app = api("api", { bind: { todos, orders } });

  app.get("/todos/:id", async (ctx) => {
    const id: string = ctx.params.id;
    const item: JsonValue = await ctx.bindings.todos.get(id);
    await ctx.bindings.orders.enqueue({ id, item });

    // @ts-expect-error only declared bindings are exposed.
    void ctx.bindings.missing;

    // @ts-expect-error kv clients do not expose queue operations.
    await ctx.bindings.todos.enqueue({ id });
  });
}

void assertHandlerContextTypes;
