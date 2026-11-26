import { api, kv, queue, type Handler } from "../src/triggers.js";
import { type JsonValue } from "../src/json.js";


const todos = kv("todos");
const orders = queue("orders");
type Bindings = { todos: typeof todos; orders: typeof orders };

async function assertHandlerContextTypes() {
  const app = api("api", { bind: { todos, orders } satisfies Bindings });

  const handler: Handler<Bindings> = async (ctx) => {
    const id: string = ctx.params.id;
    const item: JsonValue = await ctx.bindings.todos.get(id);
    await ctx.bindings.orders.enqueue({ id, item });

    // @ts-expect-error only declared bindings are exposed.
    void ctx.bindings.missing;

    // @ts-expect-error kv clients do not expose queue operations.
    await ctx.bindings.todos.enqueue({ id });
  };

  app.get("/todos/:id", handler);
}

void assertHandlerContextTypes;
