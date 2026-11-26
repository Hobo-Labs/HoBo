/** Plan 21 hello-bindle IfC authoring surface (collection target). */
export function defineHelloBindle(collect) {
	const todos = collect.kv("todos");
	const main = collect.api("main", { bind: { todos } });

	main.route("GET", "/todos/:id", () => todos.get("todo-1"));
	main.route("POST", "/todos", () => todos.set("todo-1", { title: "ship" }));
}
