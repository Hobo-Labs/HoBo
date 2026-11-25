import {
	SCHEMA_IR_CONTRACT,
	type SchemaColumn,
	type SchemaIr,
	type SchemaTable,
} from "@hobo/core";

function col(overrides: Partial<SchemaColumn> & Pick<SchemaColumn, "name" | "type">): SchemaColumn {
	return {
		nullable: false,
		primaryKey: false,
		unique: false,
		...overrides,
	};
}

function tbl(name: string, columns: readonly SchemaColumn[]): SchemaTable {
	return { name, columns, indexes: [] };
}

const user: SchemaTable = tbl("user", [
	col({ name: "id", type: "text", primaryKey: true, unique: true }),
	col({ name: "name", type: "text" }),
	col({ name: "email", type: "text", unique: true }),
	col({ name: "emailVerified", type: "boolean", nullable: true }),
	col({ name: "image", type: "text", nullable: true }),
	col({ name: "createdAt", type: "timestamp with time zone" }),
	col({ name: "updatedAt", type: "timestamp with time zone" }),
]);

const session: SchemaTable = tbl("session", [
	col({ name: "id", type: "text", primaryKey: true, unique: true }),
	col({ name: "expiresAt", type: "timestamp with time zone" }),
	col({ name: "token", type: "text", unique: true }),
	col({ name: "createdAt", type: "timestamp with time zone" }),
	col({ name: "updatedAt", type: "timestamp with time zone" }),
	col({ name: "userId", type: "text" }),
]);

const account: SchemaTable = tbl("account", [
	col({ name: "id", type: "text", primaryKey: true, unique: true }),
	col({ name: "accountId", type: "text" }),
	col({ name: "providerId", type: "text" }),
	col({ name: "userId", type: "text" }),
	col({ name: "accessToken", type: "text", nullable: true }),
	col({ name: "refreshToken", type: "text", nullable: true }),
	col({ name: "idToken", type: "text", nullable: true }),
	col({
		name: "accessTokenExpiresAt",
		type: "timestamp with time zone",
		nullable: true,
	}),
	col({
		name: "refreshTokenExpiresAt",
		type: "timestamp with time zone",
		nullable: true,
	}),
	col({ name: "scope", type: "text", nullable: true }),
	col({ name: "password", type: "text", nullable: true }),
	col({ name: "createdAt", type: "timestamp with time zone" }),
	col({ name: "updatedAt", type: "timestamp with time zone" }),
]);

const verification: SchemaTable = tbl("verification", [
	col({ name: "id", type: "text", primaryKey: true, unique: true }),
	col({ name: "identifier", type: "text" }),
	col({ name: "value", type: "text" }),
	col({ name: "expiresAt", type: "timestamp with time zone" }),
	col({ name: "createdAt", type: "timestamp with time zone" }),
	col({ name: "updatedAt", type: "timestamp with time zone" }),
]);

export const BETTER_AUTH_RELATIONAL_TABLES = Object.freeze([
	user,
	session,
	account,
	verification,
] as const);

export const BETTER_AUTH_RELATIONAL_SCHEMA_IR: SchemaIr = Object.freeze({
	contract: SCHEMA_IR_CONTRACT,
	dialect: "postgres",
	tables: BETTER_AUTH_RELATIONAL_TABLES,
});