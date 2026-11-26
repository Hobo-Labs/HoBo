// An in-memory S3-compatible endpoint behind the HttpTransport port: path-style
// object PUT/GET/HEAD/DELETE with If-None-Match, ListObjectsV2, and multipart
// (objects become visible only on CompleteMultipartUpload). It refuses any
// request whose SigV4 headers are missing or whose payload hash is wrong.
import { createHash } from "node:crypto";
import type {
	HttpTransport,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";

type StoredObject = { body: string; headers: Record<string, string> };

export class FakeS3 {
	readonly objects = new Map<string, StoredObject>();
	readonly uploads = new Map<
		string,
		{ key: string; headers: Record<string, string>; parts: Map<number, string> }
	>();
	readonly requests: TransportRequest[] = [];
	/** Make the next request whose `operation(request)` is true fail with this status. */
	failNext:
		| { when: (request: TransportRequest) => boolean; status: number }
		| undefined;
	/** Make the next matching request throw (an unknown outcome on the wire). */
	throwNext: { when: (request: TransportRequest) => boolean } | undefined;
	private uploadSeq = 0;

	constructor(
		readonly endpoint: string,
		readonly bucket: string,
		readonly accessKeyId: string,
	) {}

	visibleKeys(): string[] {
		return [...this.objects.keys()].sort();
	}

	readonly http: HttpTransport = async (request) => {
		this.requests.push(request);
		if (this.throwNext?.when(request)) {
			this.throwNext = undefined;
			throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
		}
		if (this.failNext?.when(request)) {
			const status = this.failNext.status;
			this.failNext = undefined;
			return {
				status,
				headers: {},
				body: "<Error><Code>Injected</Code></Error>",
			};
		}
		const auth = request.headers.Authorization ?? "";
		if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/`))
			return {
				status: 403,
				headers: {},
				body: "<Error><Code>AccessDenied</Code></Error>",
			};
		const payloadHash = createHash("sha256")
			.update(request.body ?? "")
			.digest("hex");
		if (request.headers["x-amz-content-sha256"] !== payloadHash)
			return {
				status: 400,
				headers: {},
				body: "<Error><Code>XAmzContentSHA256Mismatch</Code></Error>",
			};
		return this.handle(request);
	};

	private handle(request: TransportRequest): TransportResponse {
		const url = new URL(request.url);
		const prefix = `/${this.bucket}`;
		if (!url.pathname.startsWith(prefix))
			return { status: 404, headers: {}, body: "" };
		const key = decodeURIComponent(url.pathname.slice(prefix.length + 1));
		const query = url.searchParams;
		if (key === "") return this.list(query);
		if (request.method === "POST" && query.has("uploads")) {
			this.uploadSeq += 1;
			const uploadId = `upload+${this.uploadSeq}/x=`;
			this.uploads.set(uploadId, {
				key,
				headers: { ...request.headers },
				parts: new Map(),
			});
			return {
				status: 200,
				headers: {},
				body: `<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
			};
		}
		const uploadId = query.get("uploadId");
		if (uploadId !== null) {
			const upload = this.uploads.get(uploadId);
			if (upload === undefined)
				return {
					status: 404,
					headers: {},
					body: "<Error><Code>NoSuchUpload</Code></Error>",
				};
			if (request.method === "PUT") {
				const number = Number(query.get("partNumber"));
				upload.parts.set(number, request.body ?? "");
				return { status: 200, headers: { etag: `"etag-${number}"` }, body: "" };
			}
			if (request.method === "DELETE") {
				this.uploads.delete(uploadId);
				return { status: 204, headers: {}, body: "" };
			}
			if (request.method === "POST") {
				if (request.headers["if-none-match"] === "*" && this.objects.has(key))
					return {
						status: 412,
						headers: {},
						body: "<Error><Code>PreconditionFailed</Code></Error>",
					};
				const numbers = [
					...(request.body ?? "").matchAll(/<PartNumber>(\d+)<\/PartNumber>/g),
				].map((match) => Number(match[1]));
				const body = numbers
					.map((number) => upload.parts.get(number) ?? "")
					.join("");
				this.objects.set(key, { body, headers: metaHeaders(upload.headers) });
				this.uploads.delete(uploadId);
				return {
					status: 200,
					headers: {},
					body: "<CompleteMultipartUploadResult/>",
				};
			}
		}
		switch (request.method) {
			case "PUT":
				if (request.headers["if-none-match"] === "*" && this.objects.has(key))
					return {
						status: 412,
						headers: {},
						body: "<Error><Code>PreconditionFailed</Code></Error>",
					};
				this.objects.set(key, {
					body: request.body ?? "",
					headers: metaHeaders(request.headers),
				});
				return { status: 200, headers: { etag: '"single"' }, body: "" };
			case "GET": {
				const object = this.objects.get(key);
				return object === undefined
					? {
							status: 404,
							headers: {},
							body: "<Error><Code>NoSuchKey</Code></Error>",
						}
					: { status: 200, headers: { ...object.headers }, body: object.body };
			}
			case "HEAD":
				return {
					status: this.objects.has(key) ? 200 : 404,
					headers: {},
					body: "",
				};
			case "DELETE":
				this.objects.delete(key);
				return { status: 204, headers: {}, body: "" };
			default:
				return { status: 405, headers: {}, body: "" };
		}
	}

	private list(query: URLSearchParams): TransportResponse {
		const prefix = query.get("prefix") ?? "";
		const keys = this.visibleKeys().filter((key) => key.startsWith(prefix));
		const start = Number(query.get("continuation-token") ?? "0");
		const page = keys.slice(start, start + 2);
		const truncated = start + 2 < keys.length;
		const body = `<ListBucketResult>${page.map((key) => `<Contents><Key>${key}</Key></Contents>`).join("")}<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + 2}</NextContinuationToken>` : ""}</ListBucketResult>`;
		return { status: 200, headers: {}, body };
	}
}

function metaHeaders(headers: Readonly<Record<string, string>>) {
	return Object.fromEntries(
		Object.entries(headers).filter(
			([name]) => name.startsWith("x-amz-meta-") || name === "content-type",
		),
	);
}
