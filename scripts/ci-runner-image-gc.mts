import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
	selectWorkerImageTagsForDeletion,
	type WorkerImage,
} from "../packages/ci-gh-actions/src/isolated-worker/image-gc.ts";

const exec = promisify(execFile);
const dockerImage = z.object({
	ID: z.string().min(1),
	Repository: z.string(),
	Tag: z.string(),
	CreatedAt: z.string(),
});
const version = process.argv[2];
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
			.map((line) => dockerImage.parse(JSON.parse(line)))
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
