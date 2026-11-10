// The live lane's harness: one shared client, one database per binding,
// dropped when the binding closes. Nothing here runs unless
// HOBO_TEST_MONGODB_URL is set.
import type { EngineBinding, EngineHarness } from "@hobo/data-core";
import { type Db, MongoClient } from "mongodb";
import { createMongoEngine, type MongoExecutor } from "../../src/index.js";
import { createMongoDriverExecutor } from "./driver-executor.js";

/** The connection string, from the environment only; never logged. */
export const LIVE_URL = process.env.HOBO_TEST_MONGODB_URL ?? "";

export interface LiveMongo {
	readonly client: MongoClient;
	/** A database name unique to this run. */
	database(): string;
	/** The driver's own handle, for writes that deliberately bypass the binding. */
	native(database: string): Db;
	/** An executor over a database; `drop` removes the database on close. */
	executor(database: string, drop: boolean): MongoExecutor;
	/** A fresh database behind every binding, dropped when it closes. */
	harness(): EngineHarness;
	/** Databases this run created that still exist. */
	leftovers(): Promise<readonly string[]>;
	close(): Promise<void>;
}

export async function connectLive(): Promise<LiveMongo> {
	const client = new MongoClient(LIVE_URL, { serverSelectionTimeoutMS: 5_000 });
	await client.connect();
	const prefix = `hobo_mongo_${process.pid.toString(36)}${Date.now().toString(36)}_`;
	let counter = 0;
	const database = (): string => {
		counter += 1;
		return `${prefix}${counter}`;
	};
	const executor = (name: string, drop: boolean): MongoExecutor =>
		createMongoDriverExecutor({
			client,
			database: name,
			dropDatabaseOnClose: drop,
		});
	return {
		client,
		database,
		native: (name) => client.db(name),
		executor,
		harness: () => ({
			create: (): EngineBinding =>
				createMongoEngine({ executor: executor(database(), true) }),
		}),
		async leftovers() {
			const { databases } = await client.db("admin").admin().listDatabases({
				nameOnly: true,
			});
			return databases
				.map((entry) => entry.name)
				.filter((name) => name.startsWith(prefix));
		},
		close: () => client.close(),
	};
}
