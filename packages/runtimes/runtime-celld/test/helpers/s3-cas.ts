import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isJsonString } from "../../src/json.js";

export interface S3Object {
	bytes: Buffer;
	etag: string;
}

export interface S3CasServer {
	readonly url: string;
	readonly port: number;
	readonly objects: Map<string, S3Object>;
	readonly requests: Array<{ method: string; url: string }>;
	close(): Promise<void>;
}

function etagOf(bytes: Buffer): string {
	return `"${createHash("md5").update(bytes).digest("hex")}"`;
}

function listXml(
	bucket: string,
	entries: readonly { key: string; size: number; etag: string }[],
): string {
	const contents = entries
		.map(
			(entry) =>
				`<Contents><Key>${entry.key}</Key><LastModified>2026-08-14T00:00:00.000Z</LastModified><Size>${entry.size}</Size><ETag>${entry.etag}</ETag></Contents>`,
		)
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${bucket}</Name>
  <Prefix></Prefix>
  <KeyCount>${entries.length}</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  ${contents}
</ListBucketResult>`;
}

export async function startS3CasServer(): Promise<S3CasServer> {
	const objects = new Map<string, S3Object>();
	const requests: Array<{ method: string; url: string }> = [];
	const server: Server = createServer((req, res) => {
		requests.push({ method: req.method ?? "?", url: req.url ?? "/" });
		const chunks: Buffer[] = [];
		req.on("data", (chunk) =>
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
		);
		req.on("end", () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const parts = url.pathname.split("/").filter(Boolean);
			const bucket = parts[0] ?? "";
			const key = parts.slice(1).join("/");
			const objectKey = `${bucket}/${key}`;
			if (req.method === "GET" && url.searchParams.has("list-type")) {
				const prefix = url.searchParams.get("prefix") ?? "";
				const entries = [...objects.entries()]
					.filter(([item]) => item.startsWith(`${bucket}/`))
					.map(([item, value]) => ({
						key: item.slice(bucket.length + 1),
						size: value.bytes.length,
						etag: value.etag,
					}))
					.filter((entry) => entry.key.startsWith(prefix));
				res.statusCode = 200;
				res.setHeader("content-type", "application/xml");
				res.end(listXml(bucket, entries));
				return;
			}
			if (req.method === "HEAD") {
				const found = objects.get(objectKey);
				if (!found) {
					res.statusCode = 404;
					res.end();
					return;
				}
				res.statusCode = 200;
				res.setHeader("etag", found.etag);
				res.setHeader("content-length", String(found.bytes.length));
				res.end();
				return;
			}
			if (req.method === "GET") {
				const found = objects.get(objectKey);
				if (!found) {
					res.statusCode = 404;
					res.setHeader("content-type", "application/xml");
					res.end(`<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>`);
					return;
				}
				res.statusCode = 200;
				res.setHeader("etag", found.etag);
				res.end(found.bytes);
				return;
			}
			if (req.method === "DELETE") {
				objects.delete(objectKey);
				res.statusCode = 204;
				res.end();
				return;
			}
			if (req.method === "PUT") {
				const body = Buffer.concat(chunks);
				const ifNoneMatch = req.headers["if-none-match"];
				const ifMatch = req.headers["if-match"];
				const existing = objects.get(objectKey);
				if (ifNoneMatch === "*" && existing) {
					res.statusCode = 412;
					res.setHeader("content-type", "application/xml");
					res.end(
						`<?xml version="1.0"?><Error><Code>PreconditionFailed</Code></Error>`,
					);
					return;
				}
				if (isJsonString(ifMatch) && existing && existing.etag !== ifMatch) {
					res.statusCode = 412;
					res.setHeader("content-type", "application/xml");
					res.end(
						`<?xml version="1.0"?><Error><Code>PreconditionFailed</Code></Error>`,
					);
					return;
				}
				const stored = { bytes: body, etag: etagOf(body) };
				objects.set(objectKey, stored);
				res.statusCode = 200;
				res.setHeader("etag", stored.etag);
				res.end();
				return;
			}
			res.statusCode = 405;
			res.end();
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	// SAFETY: assertion required at this I/O or test boundary.
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		port,
		objects,
		requests,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}
