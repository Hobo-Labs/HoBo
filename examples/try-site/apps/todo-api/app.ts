import { bindle } from "@hobo/bindles";
import { intent, trainable } from "@hobo/runtime";

type Todo = { id: string; text: string; completed: boolean };
type TodoList = { items: Todo[] };

@trainable
class Todos {
	@intent("List all todos")
	list(): TodoList {
		return { items: [] };
	}

	@intent("Create a todo from text")
	create(text: string): Todo {
		return { id: "0", text, completed: false };
	}

	@intent("Toggle todo completed flag")
	toggle(id: string): Todo {
		return { id, text: "", completed: true };
	}
}

export default bindle((b) => {
	const todos = b.kv().allow("get", "set");
	return {
		todos,
		web: b.web(Todos).dependsOn(todos),
	};
});
