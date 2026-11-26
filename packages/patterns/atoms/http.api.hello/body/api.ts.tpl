import { Hono } from "hono";

export const app = new Hono().get("/hello", (c) => {
	const name = c.req.query("name")?.trim() || "world";
	const greetingPrefix = process.env.GREETING_PREFIX?.trim() || "hello";
	return c.json({
		message: `${greetingPrefix}, ${name}`,
		greetingPrefix,
	});
});
