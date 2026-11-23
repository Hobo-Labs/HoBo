import { column, table } from "./fixtures.js";

export const accounts = table("accounts", {
	id: column("id", { sqlType: "uuid", primary: true, notNull: true }),
});

export const notATable = "plain value";
