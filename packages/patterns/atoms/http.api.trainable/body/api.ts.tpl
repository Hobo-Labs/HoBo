import { Hono } from "hono";
import { training } from "@hobo/runtime";

export async function greet(input: { name: string }): Promise<{ message: string }> {
	"use training";
	return { message: `Hello, ${input.name}!` };
}

export const greetTrainable = training(greet, {
	methodRef: "{{name}}.greet",
	intent: "Greet the caller by name.",
	contract: { ref: "inferred://{{name}}.greet" },
	rubric: { exactMatch: 1 },
});

export const app = new Hono().get("/hello", async (c) => {
	const name = c.req.query("name")?.trim() || "world";
	return c.json(await greetTrainable({ name }));
});
