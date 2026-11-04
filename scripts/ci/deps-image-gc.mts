import { spawnSync } from "node:child_process";
import {
	type DepsImage,
	selectDepsImageTagsForDeletion,
} from "../lib/deps-image-gc.mts";

const currentTag = process.argv[2];
if (
	!currentTag?.startsWith("hobo-ci-deps:") ||
	currentTag === "hobo-ci-deps:local"
) {
	throw new Error(
		"usage: node scripts/ci/deps-image-gc.mts hobo-ci-deps:<key>",
	);
}

function docker(args: readonly string[]): string {
	const result = spawnSync("docker", args, { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(
			`docker ${args.join(" ")} failed: ${result.stderr.trim() || result.error?.message || `exit ${result.status}`}`,
		);
	}
	return result.stdout;
}

function lines(output: string): string[] {
	return output.split("\n").filter((line) => line.length > 0);
}

const imageIds = [
	...new Set(
		lines(
			docker([
				"image",
				"ls",
				"--no-trunc",
				"--format",
				"{{.ID}} {{.Repository}}",
			]),
		)
			.map((line) => line.split(" "))
			.filter(
				([id, repository]) =>
					id !== undefined &&
					(repository === "hobo-ci-deps" ||
						repository === "hobo-ci-deps-fetch"),
			)
			.map(([id]) => {
				if (id === undefined) throw new Error("docker image row had no ID");
				return id;
			}),
	),
];
const containerIds = lines(docker(["ps", "--quiet"]));
const runningImageIds = new Set(
	containerIds.length === 0
		? []
		: lines(docker(["inspect", "--format", "{{.Image}}", ...containerIds])),
);
const images: DepsImage[] =
	imageIds.length === 0
		? []
		: lines(
				docker([
					"image",
					"inspect",
					"--format",
					'{{range .RepoTags}}{{$.Id}} {{$.Created}} {{.}}{{"\\n"}}{{end}}',
					...imageIds,
				]),
			).map((line) => {
				const [id, created, tag, ...extra] = line.split(" ");
				const timestamp =
					created === undefined ? Number.NaN : Date.parse(created);
				if (!id || !tag || extra.length > 0 || !Number.isFinite(timestamp)) {
					throw new Error(`unexpected docker image inspect row: ${line}`);
				}
				return { tag, created: timestamp, inUse: runningImageIds.has(id) };
			});

let failed = false;
for (const tag of selectDepsImageTagsForDeletion(images, currentTag)) {
	console.log(`Removing superseded deps image tag ${tag}`);
	const result = spawnSync("docker", ["image", "rm", tag], {
		stdio: "inherit",
	});
	if (result.status !== 0) failed = true;
}
const prune = spawnSync("docker", ["image", "prune", "-f"], {
	stdio: "inherit",
});
if (prune.status !== 0 || failed) process.exitCode = 1;
