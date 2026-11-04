import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	selectWorkerImageTagsForDeletion,
	type WorkerImage,
} from "../packages/ci-gh-actions/src/isolated-worker/image-gc.ts";
import { type JsonValue, runtimeKind } from "./lib/inspectable.ts";

const exec = promisify(execFile);
type DockerImage = Readonly<{
	ID: string;
	Repository: string;
	Tag: string;
	CreatedAt: string;
}>;
type JsonObject = Readonly<{ [key: string]: JsonValue }>;

function isObject(value: JsonValue): value is JsonObject {
	return (
		value !== null && !Array.isArray(value) && runtimeKind(value) === "object"
	);
}

function isString(value: JsonValue | undefined): value is string {
	return runtimeKind(value) === "string";
}

function stringField(record: JsonObject, key: string): string {
	const value = record[key];
	if (!isString(value)) throw new Error(`invalid docker image ${key}`);
	return value;
}

function parseDockerImage(line: string): DockerImage {
	const value: JsonValue = JSON.parse(line);
	if (!isObject(value)) throw new Error("invalid docker image record");
	const image = {
		ID: stringField(value, "ID"),
		Repository: stringField(value, "Repository"),
		Tag: stringField(value, "Tag"),
		CreatedAt: stringField(value, "CreatedAt"),
	};
	if (!image.ID) throw new Error("invalid docker image ID");
	return image;
}

const version = process.argv[2];
if (version === "--help") {
	console.log("Usage: node scripts/ci-runner-image-gc.mts [v<12 hex digits>]");
	process.exit(0);
}
if (version !== undefined && !/^v[0-9a-f]{12}$/u.test(version))
	throw new Error("invalid runner image version");

const [{ stdout: inventory }, { stdout: running }] = await Promise.all([
	exec("docker", ["image", "ls", "--no-trunc", "--format", "{{json .}}"], {
		timeout: 30_000,
		maxBuffer: 16 * 1024 * 1024,
	}),
	exec("docker", ["ps", "--no-trunc", "--format", "{{.Image}}"], {
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
	}),
]);
const images: WorkerImage[] = inventory.trim()
	? inventory
			.trim()
			.split("\n")
			.map(parseDockerImage)
			.filter(
				(record) => record.Repository !== "<none>" && record.Tag !== "<none>",
			)
			.map((record) => ({
				id: record.ID,
				tag: `${record.Repository}:${record.Tag}`,
				created: record.CreatedAt.replace(" ", "T").replace(
					/ ([+-]\d{2})(\d{2}) UTC$/u,
					"$1:$2",
				),
				inUse: false,
			}))
	: [];
const runningImages = new Set(running.split("\n").map((line) => line.trim()));
const runningIds = new Set(
	images
		.filter(
			(image) => runningImages.has(image.tag) || runningImages.has(image.id),
		)
		.map((image) => image.id),
);
const inventoryWithUsage = images.map((image) => ({
	...image,
	inUse: runningIds.has(image.id),
}));
for (const tag of selectWorkerImageTagsForDeletion(
	inventoryWithUsage,
	version,
)) {
	await exec("docker", ["image", "rm", "--no-prune", tag], {
		timeout: 120_000,
		maxBuffer: 1024 * 1024,
	});
	console.log(`Removed stale runner image ${tag}`);
}
