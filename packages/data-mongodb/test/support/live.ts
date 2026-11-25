import type { EngineBinding, EngineHarness } from "@hobo/data-core";
import { type Db, MongoClient } from "mongodb";
import {
	createMongoEngine,
	MONGO_CONFORMANCE_DECLARED_LIMITS,
	type MongoExecutor,
} from "../../src/index.js";
import { createMongoDriverExecutor } from "./driver-executor.js";

export const LIVE_URL = process.env.HOBO_TEST_MONGODB_URL ?? "";

export interface LiveMongo {
	readonly client: MongoClient;
	database(): string;
	native(database: string): Db;
	executor(database: string, drop: boolean): MongoExecutor;
	harness(): EngineHarness;
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
			declaredLimits: MONGO_CONFORMANCE_DECLARED_LIMITS,
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
