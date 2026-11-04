import { getTrainable, intent, trainable } from "../../src/index.js";

type Todo = { id: string; text: string; completed: boolean };
type TodoList = { items: Todo[] };

@trainable
export class Todos {
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

export const createIntent = getTrainable("Todos.create")?.fact.intent;
