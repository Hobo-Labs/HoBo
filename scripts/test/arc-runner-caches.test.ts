import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AutoscalingRunnerSetSchema,
	arcRunnerCachePatch,
	CACHE_OWNER_INIT,
	POD_IMAGE_CACHE,
	POD_PNPM_STORE,
	type RunnerPodSpec,
	storePrewarmJob,
	withRunnerCaches,
} from "../ci/arc-runner-caches.mts";
import { withFleetPnpmStore } from "../ci/pnpm-install.mts";

const IMAGE = "ghcr.io/hobo-labs/hobo/hobo-ci-worker:v0123456789ab";
const SHA = "4da35cfd92854b07ea368680fcc19a621faa928f";

function scaleSet(spec: RunnerPodSpec) {
	return AutoscalingRunnerSetSchema.parse({
		metadata: { name: "hobo-trunk", namespace: "arc-runners" },
		spec: { template: { spec } },
	});
}

describe("ARC runner node caches", () => {
	it("mounts a node-shared pnpm store and image cache into the runner and names them in its env", () => {
		const set = scaleSet({
			containers: [
				{ name: "dind", image: "docker:dind" },
				{
					name: "runner",
					image: IMAGE,
					env: [{ name: "DOCKER_HOST", value: "unix:///var/run/docker.sock" }],
					volumeMounts: [{ name: "work", mountPath: "/home/runner/_work" }],
				},
			],
			volumes: [{ name: "work", emptyDir: {} }],
		});
		assert.deepEqual(
			arcRunnerCachePatch(set).map((op) => op.path),
			[
				"/spec/template/spec/volumes/-",
				"/spec/template/spec/volumes/-",
				"/spec/template/spec/initContainers",
				"/spec/template/spec/containers/1/volumeMounts/-",
				"/spec/template/spec/containers/1/volumeMounts/-",
				"/spec/template/spec/containers/1/env/-",
				"/spec/template/spec/containers/1/env/-",
			],
		);
		const patched = withRunnerCaches(set);
		const pod = patched.spec.template.spec;
		const runner = pod.containers[1];
		assert.deepEqual(
			runner?.volumeMounts?.map((mount) => mount.name),
			["work", "hobo-pnpm-store", "hobo-image-cache"],
		);
		assert.deepEqual(
			runner?.env?.filter((entry) => entry.name.startsWith("HOBO_CI_")),
			[
				{ name: "HOBO_CI_PNPM_STORE_DIR", value: POD_PNPM_STORE },
				{ name: "HOBO_CI_IMAGE_CACHE_DIR", value: POD_IMAGE_CACHE },
			],
		);
		assert.deepEqual(
			pod.volumes?.map((volume) => volume.name),
			["work", "hobo-pnpm-store", "hobo-image-cache"],
		);
		assert.deepEqual(
			pod.initContainers?.map((init) => init.name),
			[CACHE_OWNER_INIT],
		);
		assert.deepEqual(arcRunnerCachePatch(patched), []);
	});

	it("creates the lists a minimal runner template leaves out", () => {
		const set = scaleSet({ containers: [{ name: "runner", image: IMAGE }] });
		const ops = arcRunnerCachePatch(set);
		assert.deepEqual(
			ops.map((op) => op.path),
			[
				"/spec/template/spec/volumes",
				"/spec/template/spec/initContainers",
				"/spec/template/spec/containers/0/volumeMounts",
				"/spec/template/spec/containers/0/env",
			],
		);
		assert.deepEqual(arcRunnerCachePatch(withRunnerCaches(set)), []);
	});

	it("refuses a template without a runner container or image", () => {
		assert.throws(
			() =>
				arcRunnerCachePatch(
					scaleSet({ containers: [{ name: "x", image: IMAGE }] }),
				),
			/no container named runner/u,
		);
		assert.throws(
			() => arcRunnerCachePatch(scaleSet({ containers: [{ name: "runner" }] })),
			/names no image/u,
		);
	});

	it("makes a pnpm install in the patched pod use the shared store", () => {
		assert.equal(
			withFleetPnpmStore({ HOBO_CI_PNPM_STORE_DIR: POD_PNPM_STORE }, () => true)
				.npm_config_store_dir,
			POD_PNPM_STORE,
		);
	});

	it("prewarms the node store from the full lockfile at an exact commit", () => {
		const set = scaleSet({ containers: [{ name: "runner", image: IMAGE }] });
		const job = JSON.stringify(storePrewarmJob(set, "Hobo-Labs/HoBo", SHA));
		assert.match(
			job,
			/raw\.githubusercontent\.com\/Hobo-Labs\/HoBo\/4da35cfd92854b07ea368680fcc19a621faa928f\/pnpm-lock\.yaml/u,
		);
		assert.match(job, /pnpm fetch --frozen-lockfile --store-dir \/pnpm-store/u);
		assert.match(job, /"path":"\/var\/lib\/hobo-ci\/pnpm-store"/u);
		assert.throws(
			() => storePrewarmJob(set, "Hobo-Labs/HoBo", "main"),
			/full commit SHA/u,
		);
		assert.throws(() => storePrewarmJob(set, "no repo", SHA), /owner\/name/u);
	});
});
