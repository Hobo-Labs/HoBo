/** Seed a synthetic image through the suite's loopback-only emulator transport. */
import { gzipSync } from "node:zlib";
import type { HttpTransport } from "@hobo/core";
import {
	type AwsCredentials,
	sha256Hex,
	signAwsRequest,
} from "@hobo/core/aws-sigv4";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonObject,
} from "../../src/json.js";

export async function seedEmulatorImage(
	transport: HttpTransport,
	credentials: AwsCredentials,
): Promise<string> {
	const region = "us-east-1";
	const repositoryName = "hobo-emulator-app";
	const url = `https://api.ecr.${region}.amazonaws.com/`;
	async function ecr(operation: string, value: JsonObject) {
		const body = JSON.stringify(value);
		const signed = signAwsRequest({
			method: "POST",
			url,
			region,
			service: "ecr",
			credentials,
			now: new Date(),
			body,
			headers: {
				"content-type": "application/x-amz-json-1.1",
				"x-amz-target": `AmazonEC2ContainerRegistry_V20150921.${operation}`,
			},
		});
		const response = await transport({
			method: "POST",
			url,
			body,
			headers: signed.headers,
			timeoutMs: 15_000,
			maxResponseBytes: 512 * 1024,
		});
		if (response.status !== 200)
			throw new Error(
				`AWS Emulator ECR ${operation} returned ${response.status}`,
			);
		return parseJsonObject(response.body);
	}
	await ecr("CreateRepository", { repositoryName });
	async function upload(bytes: Buffer): Promise<string> {
		const started = await ecr("InitiateLayerUpload", { repositoryName });
		if (!isJsonString(started.uploadId))
			throw new Error("ECR upload ID is missing");
		const uploadId = started.uploadId;
		await ecr("UploadLayerPart", {
			repositoryName,
			uploadId,
			partFirstByte: 0,
			partLastByte: bytes.length - 1,
			layerPartBlob: bytes.toString("base64"),
		});
		const digest = `sha256:${sha256Hex(bytes)}`;
		await ecr("CompleteLayerUpload", {
			repositoryName,
			uploadId,
			layerDigests: [digest],
		});
		return digest;
	}
	const layerBytes = Buffer.from("fictional local image layer\n");
	const layer = gzipSync(layerBytes);
	const layerDigest = await upload(layer);
	const config = Buffer.from(
		JSON.stringify({
			architecture: "arm64",
			os: "linux",
			config: { Cmd: ["/placeholder"] },
			rootfs: { type: "layers", diff_ids: [`sha256:${sha256Hex(layerBytes)}`] },
		}),
	);
	const configDigest = await upload(config);
	const manifest = JSON.stringify({
		schemaVersion: 2,
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		config: {
			mediaType: "application/vnd.oci.image.config.v1+json",
			digest: configDigest,
			size: config.length,
		},
		layers: [
			{
				mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
				digest: layerDigest,
				size: layer.length,
			},
		],
	});
	const result = await ecr("PutImage", {
		repositoryName,
		imageTag: "fixture",
		imageManifest: manifest,
	});
	const image = result.image;
	if (
		!isJsonObject(image) ||
		!isJsonObject(image.imageId) ||
		!isJsonString(image.imageId.imageDigest)
	)
		throw new Error("ECR image digest is missing");
	const digest = `sha256:${sha256Hex(manifest)}`;
	if (image.imageId.imageDigest !== digest)
		throw new Error("ECR image digest did not match the uploaded manifest");
	return `000000000000.dkr.ecr.${region}.amazonaws.com/${repositoryName}@${digest}`;
}
