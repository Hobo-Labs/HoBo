// The AWS resource resolvers, driven against an injected fake transport that
// models an AWS account.
//
// What these tests are for: the resolvers are the only thing between "the Yard
// says AWS can allocate this" and "this exists in the account", and the
// property that makes them safe to re-run after a crashed half-apply is
// convergence. So the shape of nearly every case below is the same: reconcile
// twice, then assert one resource, the same physicalId, and exactly one create
// call. A resolver that duplicates a resource on every retry passes a
// create-once test and fails this one.
//
// The credential law gets its own pass: the secret access key must appear in
// no request at all (SigV4 sends a signature, never the key), the access key
// id must appear only in the `authorization` header, and neither may reach an
// outcome, an output bag, or a message — including the messages built from AWS
// error bodies, which echo request context.
//
// HONEST SCOPE: the transport here is a fake. These tests prove request
// formation, convergence, refusal codes, and redaction. They prove nothing
// about a live AWS account — that needs real credentials and real egress,
// neither of which a unit test supplies. The signature itself is proved
// separately, in `@hobo/core`, against the official SigV4 vectors.
import {
	type CapabilitySlot,
	parseResolveOutcome,
	parseResolveRequest,
	type ResolveOutcome,
	ResolverError,
	type TransportRequest,
	type TransportResponse,
} from "@hobo/core";
import type { AwsCredentials } from "@hobo/core/aws-sigv4";
import { describe, expect, it } from "vitest";

import {
	AWS_DEFAULT_BINDINGS,
	AWS_DYNAMODB_PRODUCT_ID,
	AWS_RESOLVED_PRODUCT_IDS,
	AWS_S3_PRODUCT_ID,
	AWS_SECRETS_MANAGER_PRODUCT_ID,
	AWS_SNS_PRODUCT_ID,
	AWS_SQS_FIFO_PRODUCT_ID,
	AWS_SQS_PRODUCT_ID,
	AWS_SSM_PARAMETER_PRODUCT_ID,
	AWS_UNRESOLVED_PRODUCT_IDS,
	awsResolverRegistry,
	guardedAwsTransport,
} from "../src/index.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "../src/json.js";

const REGION = "us-east-1";
const ACCOUNT = "123456789012";
const CREDENTIAL_REF = "secret://camp/aws-deploy";

/** Fictional material. The point of the credential tests is that it leaks nowhere. */
const CREDENTIALS: AwsCredentials = {
	accessKeyId: "AKIAHOBOFAKEKEYID001",
	secretAccessKey: "n0tARealSecretAccessKey0000000000000000x",
	sessionToken: "FwoGZXIvYXdzEHOBOFAKESESSIONTOKEN",
};

/** A frozen instant, so a signed request is byte-stable across runs. */
const NOW_MS = Date.parse("2026-03-04T05:06:07.000Z");

// ---------------------------------------------------------------------------
// The fake account
// ---------------------------------------------------------------------------

interface FakeBucket {
	location: string;
	versioning: string | undefined;
	publicAccessBlocked: boolean;
}

interface FakeTable {
	partitionKey: string;
	billingMode: string;
}

interface FakeQueue {
	attributes: Record<string, string>;
}

interface FakeTopic {
	attributes: Record<string, string>;
}

interface FakeSecret {
	description: string | undefined;
	kmsKeyId: string | undefined;
}

interface FakeParameter {
	value: string;
	type: string;
}

interface FakeAccount {
	readonly buckets: Map<string, FakeBucket>;
	readonly tables: Map<string, FakeTable>;
	readonly queues: Map<string, FakeQueue>;
	readonly topics: Map<string, FakeTopic>;
	readonly secrets: Map<string, FakeSecret>;
	readonly parameters: Map<string, FakeParameter>;
}

function emptyAccount(): FakeAccount {
	return {
		buckets: new Map(),
		tables: new Map(),
		queues: new Map(),
		topics: new Map(),
		secrets: new Map(),
		parameters: new Map(),
	};
}

interface FakeAws {
	readonly transport: (request: TransportRequest) => Promise<TransportResponse>;
	readonly calls: TransportRequest[];
	/** Force the next matching call to answer with this response instead. */
	stub(
		match: (request: TransportRequest) => boolean,
		response: TransportResponse,
	): void;
}

function reply(status: number, body: string): TransportResponse {
	return { status, headers: {}, body };
}

function json(status: number, value: JsonValue): TransportResponse {
	return reply(status, JSON.stringify(value));
}

function jsonFault(
	status: number,
	type: string,
	message: string,
): TransportResponse {
	return json(status, { __type: `com.amazonaws.example#${type}`, message });
}

function xmlFault(
	status: number,
	code: string,
	message: string,
): TransportResponse {
	return reply(
		status,
		`<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error></ErrorResponse>`,
	);
}

function formParameters(body: string | undefined): JsonObject {
	const parsed = {};
	for (const pair of (body ?? "").split("&")) {
		if (pair === "") continue;
		const separator = pair.indexOf("=");
		const name = decodeURIComponent(
			separator < 0 ? pair : pair.slice(0, separator),
		);
		Object.assign(parsed, {
			[name]: decodeURIComponent(
				separator < 0 ? "" : pair.slice(separator + 1),
			),
		});
	}
	return parsed;
}

function formString(parameters: JsonObject, key: string): string {
	const value = parameters[key];
	return isJsonString(value) ? value : "";
}

function formOptional(parameters: JsonObject, key: string): string | undefined {
	const value = parameters[key];
	return isJsonString(value) ? value : undefined;
}

function jsonText(record: JsonObject, key: string): string {
	const value = record[key];
	return isJsonString(value) ? value : "";
}

function queueUrlOf(name: string): string {
	return `https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/${name}`;
}

function topicArnOf(name: string): string {
	return `arn:aws:sns:${REGION}:${ACCOUNT}:${name}`;
}

function queueNameFromUrl(url: string): string {
	return url.slice(url.lastIndexOf("/") + 1);
}

function createFakeAws(account: FakeAccount): FakeAws {
	const calls: TransportRequest[] = [];
	const stubs: {
		match: (request: TransportRequest) => boolean;
		response: TransportResponse;
	}[] = [];

	async function transport(
		request: TransportRequest,
	): Promise<TransportResponse> {
		calls.push(request);
		const stubIndex = stubs.findIndex((entry) => entry.match(request));
		if (stubIndex >= 0) {
			const [stub] = stubs.splice(stubIndex, 1);
			if (stub !== undefined) return stub.response;
		}
		const url = new URL(request.url);
		const service = url.hostname.split(".")[0] ?? "";
		if (service === "s3") return s3Handler(account, request, url);
		if (service === "dynamodb") return dynamoHandler(account, request);
		if (service === "sqs") return sqsHandler(account, request);
		if (service === "sns") return snsHandler(account, request);
		if (service === "secretsmanager") return secretsHandler(account, request);
		if (service === "ssm") return ssmHandler(account, request);
		return reply(404, `<Error><Code>NoSuchService</Code></Error>`);
	}

	return {
		transport,
		calls,
		stub(match, response) {
			stubs.push({ match, response });
		},
	};
}

function s3Handler(
	account: FakeAccount,
	request: TransportRequest,
	url: URL,
): TransportResponse {
	const name = decodeURIComponent(url.pathname.slice(1));
	const subresource = url.search;
	const bucket = account.buckets.get(name);

	if (request.method === "PUT" && subresource === "") {
		account.buckets.set(name, {
			location: REGION,
			versioning: undefined,
			publicAccessBlocked: false,
		});
		return reply(200, "");
	}
	if (bucket === undefined) {
		return reply(
			404,
			"<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>",
		);
	}
	if (request.method === "GET" && subresource === "?location") {
		return reply(
			200,
			`<LocationConstraint>${bucket.location}</LocationConstraint>`,
		);
	}
	if (request.method === "GET" && subresource === "?versioning") {
		return reply(
			200,
			bucket.versioning === undefined
				? "<VersioningConfiguration/>"
				: `<VersioningConfiguration><Status>${bucket.versioning}</Status></VersioningConfiguration>`,
		);
	}
	if (request.method === "GET" && subresource === "?publicAccessBlock") {
		return bucket.publicAccessBlocked
			? reply(
					200,
					"<PublicAccessBlockConfiguration><BlockPublicAcls>true</BlockPublicAcls></PublicAccessBlockConfiguration>",
				)
			: reply(
					404,
					"<Error><Code>NoSuchPublicAccessBlockConfiguration</Code></Error>",
				);
	}
	if (request.method === "PUT" && subresource === "?versioning") {
		bucket.versioning =
			(request.body ?? "").includes("<Status>Enabled</Status>") === true
				? "Enabled"
				: "Suspended";
		return reply(200, "");
	}
	if (request.method === "PUT" && subresource === "?publicAccessBlock") {
		bucket.publicAccessBlocked = true;
		return reply(200, "");
	}
	if (request.method === "DELETE" && subresource === "") {
		account.buckets.delete(name);
		return reply(204, "");
	}
	return reply(400, "<Error><Code>MethodNotAllowed</Code></Error>");
}

function dynamoHandler(
	account: FakeAccount,
	request: TransportRequest,
): TransportResponse {
	const target = (request.headers["x-amz-target"] ?? "").split(".")[1] ?? "";
	const payload = parseJsonObject(request.body ?? "{}");
	const name = jsonText(payload, "TableName");
	const table = account.tables.get(name);

	function describe(entry: FakeTable) {
		return {
			TableName: name,
			TableArn: `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${name}`,
			TableStatus: "ACTIVE",
			BillingModeSummary: { BillingMode: entry.billingMode },
			KeySchema: [{ AttributeName: entry.partitionKey, KeyType: "HASH" }],
		};
	}

	if (target === "DescribeTable") {
		return table === undefined
			? jsonFault(
					400,
					"ResourceNotFoundException",
					"Requested resource not found",
				)
			: json(200, { Table: describe(table) });
	}
	if (target === "CreateTable") {
		if (table !== undefined) {
			return jsonFault(400, "ResourceInUseException", "Table already exists");
		}
		const schema = payload.KeySchema;
		const first = isJsonArray(schema) ? schema[0] : undefined;
		const partitionKey =
			isJsonObject(first) && isJsonString(first.AttributeName)
				? first.AttributeName
				: "";
		const created: FakeTable = {
			partitionKey,
			billingMode: jsonText(payload, "BillingMode") || "PROVISIONED",
		};
		account.tables.set(name, created);
		return json(200, { TableDescription: describe(created) });
	}
	if (target === "UpdateTable") {
		if (table === undefined) {
			return jsonFault(
				400,
				"ResourceNotFoundException",
				"Requested resource not found",
			);
		}
		table.billingMode = jsonText(payload, "BillingMode") || table.billingMode;
		return json(200, { TableDescription: describe(table) });
	}
	if (target === "DeleteTable") {
		if (table === undefined) {
			return jsonFault(
				400,
				"ResourceNotFoundException",
				"Requested resource not found",
			);
		}
		account.tables.delete(name);
		return json(200, { TableDescription: describe(table) });
	}
	return jsonFault(400, "UnknownOperationException", target);
}

function sqsHandler(
	account: FakeAccount,
	request: TransportRequest,
): TransportResponse {
	const parameters = formParameters(request.body);
	const action = formString(parameters, "Action");

	if (action === "GetQueueUrl") {
		const name = formString(parameters, "QueueName");
		return account.queues.has(name)
			? reply(
					200,
					`<GetQueueUrlResponse><GetQueueUrlResult><QueueUrl>${queueUrlOf(name)}</QueueUrl></GetQueueUrlResult></GetQueueUrlResponse>`,
				)
			: xmlFault(
					400,
					"AWS.SimpleQueueService.NonExistentQueue",
					"The specified queue does not exist",
				);
	}
	if (action === "CreateQueue") {
		const name = formString(parameters, "QueueName");
		const attributes = {
			QueueArn: `arn:aws:sqs:${REGION}:${ACCOUNT}:${name}`,
		};
		for (let index = 1; index <= 10; index += 1) {
			const key = formOptional(parameters, `Attribute.${index}.Name`);
			const value = formOptional(parameters, `Attribute.${index}.Value`);
			if (key === undefined || value === undefined) break;
			Object.assign(attributes, { [key]: value });
		}
		account.queues.set(name, { attributes });
		return reply(
			200,
			`<CreateQueueResponse><CreateQueueResult><QueueUrl>${queueUrlOf(name)}</QueueUrl></CreateQueueResult></CreateQueueResponse>`,
		);
	}
	const name = queueNameFromUrl(formString(parameters, "QueueUrl"));
	const queue = account.queues.get(name);
	if (queue === undefined) {
		return xmlFault(
			400,
			"AWS.SimpleQueueService.NonExistentQueue",
			"The specified queue does not exist",
		);
	}
	if (action === "GetQueueAttributes") {
		const entries = Object.entries(queue.attributes)
			.map(
				([key, value]) =>
					`<Attribute><Name>${key}</Name><Value>${value}</Value></Attribute>`,
			)
			.join("");
		return reply(
			200,
			`<GetQueueAttributesResponse><GetQueueAttributesResult>${entries}</GetQueueAttributesResult></GetQueueAttributesResponse>`,
		);
	}
	if (action === "SetQueueAttributes") {
		const key = formOptional(parameters, "Attribute.1.Name");
		const value = formOptional(parameters, "Attribute.1.Value");
		if (key !== undefined && value !== undefined) {
			Object.assign(queue.attributes, { [key]: value });
		}
		return reply(200, "<SetQueueAttributesResponse/>");
	}
	if (action === "DeleteQueue") {
		account.queues.delete(name);
		return reply(200, "<DeleteQueueResponse/>");
	}
	return xmlFault(400, "InvalidAction", action);
}

function snsHandler(
	account: FakeAccount,
	request: TransportRequest,
): TransportResponse {
	const parameters = formParameters(request.body);
	const action = formString(parameters, "Action");

	if (action === "ListTopics") {
		const members = [...account.topics.keys()]
			.map(
				(name) => `<member><TopicArn>${topicArnOf(name)}</TopicArn></member>`,
			)
			.join("");
		return reply(
			200,
			`<ListTopicsResponse><ListTopicsResult><Topics>${members}</Topics></ListTopicsResult></ListTopicsResponse>`,
		);
	}
	if (action === "CreateTopic") {
		const name = formString(parameters, "Name");
		const attributes = {};
		for (let index = 1; index <= 10; index += 1) {
			const key = formOptional(parameters, `Attributes.entry.${index}.key`);
			const value = formOptional(parameters, `Attributes.entry.${index}.value`);
			if (key === undefined || value === undefined) break;
			Object.assign(attributes, { [key]: value });
		}
		account.topics.set(name, { attributes });
		return reply(
			200,
			`<CreateTopicResponse><CreateTopicResult><TopicArn>${topicArnOf(name)}</TopicArn></CreateTopicResult></CreateTopicResponse>`,
		);
	}
	const arn = formString(parameters, "TopicArn");
	const name = arn.slice(arn.lastIndexOf(":") + 1);
	const topic = account.topics.get(name);
	if (topic === undefined) {
		return xmlFault(404, "NotFound", "Topic does not exist");
	}
	if (action === "GetTopicAttributes") {
		const entries = Object.entries({ TopicArn: arn, ...topic.attributes })
			.map(
				([key, value]) =>
					`<entry><key>${key}</key><value>${value}</value></entry>`,
			)
			.join("");
		return reply(
			200,
			`<GetTopicAttributesResponse><GetTopicAttributesResult><Attributes>${entries}</Attributes></GetTopicAttributesResult></GetTopicAttributesResponse>`,
		);
	}
	if (action === "SetTopicAttributes") {
		const key = formOptional(parameters, "AttributeName");
		const value = formOptional(parameters, "AttributeValue");
		if (key !== undefined && value !== undefined) {
			Object.assign(topic.attributes, { [key]: value });
		}
		return reply(200, "<SetTopicAttributesResponse/>");
	}
	if (action === "DeleteTopic") {
		account.topics.delete(name);
		return reply(200, "<DeleteTopicResponse/>");
	}
	return xmlFault(400, "InvalidAction", action);
}

function secretsHandler(
	account: FakeAccount,
	request: TransportRequest,
): TransportResponse {
	const target = (request.headers["x-amz-target"] ?? "").split(".")[1] ?? "";
	const payload = parseJsonObject(request.body ?? "{}");
	const name = jsonText(payload, "SecretId") || jsonText(payload, "Name");
	const secret = account.secrets.get(name);

	function describe(entry: FakeSecret) {
		return {
			ARN: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${name}-AbCdEf`,
			Name: name,
			...(entry.description === undefined
				? undefined
				: { Description: entry.description }),
			...(entry.kmsKeyId === undefined
				? undefined
				: { KmsKeyId: entry.kmsKeyId }),
		};
	}

	if (target === "DescribeSecret") {
		return secret === undefined
			? jsonFault(
					400,
					"ResourceNotFoundException",
					"Secrets Manager can't find the specified secret",
				)
			: json(200, describe(secret));
	}
	if (target === "CreateSecret") {
		if (secret !== undefined) {
			return jsonFault(
				400,
				"ResourceExistsException",
				"The operation failed because the secret already exists",
			);
		}
		const created: FakeSecret = {
			description: isJsonString(payload.Description)
				? payload.Description
				: undefined,
			kmsKeyId: isJsonString(payload.KmsKeyId) ? payload.KmsKeyId : undefined,
		};
		account.secrets.set(name, created);
		return json(200, describe(created));
	}
	if (target === "UpdateSecret") {
		if (secret === undefined) {
			return jsonFault(
				400,
				"ResourceNotFoundException",
				"Secrets Manager can't find the specified secret",
			);
		}
		if (isJsonString(payload.Description)) {
			secret.description = payload.Description;
		}
		if (isJsonString(payload.KmsKeyId)) secret.kmsKeyId = payload.KmsKeyId;
		return json(200, describe(secret));
	}
	if (target === "DeleteSecret") {
		if (secret === undefined) {
			return jsonFault(
				400,
				"ResourceNotFoundException",
				"Secrets Manager can't find the specified secret",
			);
		}
		account.secrets.delete(name);
		return json(200, describe(secret));
	}
	return jsonFault(400, "UnknownOperationException", target);
}

function ssmHandler(
	account: FakeAccount,
	request: TransportRequest,
): TransportResponse {
	const target = (request.headers["x-amz-target"] ?? "").split(".")[1] ?? "";
	const payload = parseJsonObject(request.body ?? "{}");
	const name = jsonText(payload, "Name");
	const parameter = account.parameters.get(name);

	if (target === "GetParameter") {
		return parameter === undefined
			? jsonFault(400, "ParameterNotFound", "Parameter not found")
			: json(200, {
					Parameter: {
						Name: name,
						ARN: `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/${name}`,
						Type: parameter.type,
						Value: parameter.value,
					},
				});
	}
	if (target === "PutParameter") {
		if (parameter !== undefined && payload.Overwrite !== true) {
			return jsonFault(
				400,
				"ParameterAlreadyExists",
				"The parameter already exists",
			);
		}
		account.parameters.set(name, {
			value: jsonText(payload, "Value"),
			type: jsonText(payload, "Type") || "String",
		});
		return json(200, { Version: 1, Tier: payload.Tier ?? "Standard" });
	}
	if (target === "DeleteParameter") {
		if (parameter === undefined) {
			return jsonFault(400, "ParameterNotFound", "Parameter not found");
		}
		account.parameters.delete(name);
		return json(200, {});
	}
	return jsonFault(400, "UnknownOperationException", target);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
	readonly account: FakeAccount;
	readonly aws: FakeAws;
	reconcile(product: ProductCase): Promise<ResolveOutcome>;
	read(product: ProductCase): Promise<ResolveOutcome | undefined>;
	remove(product: ProductCase): Promise<void>;
}

interface ProductCase {
	readonly label: string;
	readonly productId: string;
	readonly slot: CapabilitySlot;
	readonly logicalId: string;
	readonly desired: JsonObject;
	/** How many of this product exist in the fake account. */
	count(account: FakeAccount): number;
	/** Does this request create the resource (as opposed to reading it)? */
	isCreate(request: TransportRequest): boolean;
}

function harness(
	account: FakeAccount = emptyAccount(),
	credentials: AwsCredentials = CREDENTIALS,
): Harness {
	const aws = createFakeAws(account);
	const registry = awsResolverRegistry({
		region: REGION,
		nowMs: NOW_MS,
		resolveCredential: async (ref) => {
			if (ref !== CREDENTIAL_REF) throw new Error(`unknown credential ${ref}`);
			return credentials;
		},
	});
	const transport = guardedAwsTransport(aws.transport, REGION);

	function requestFor(product: ProductCase) {
		return parseResolveRequest({
			ref: {
				slot: product.slot,
				productId: product.productId,
				logicalId: product.logicalId,
			},
			desired: product.desired,
			credentialRef: CREDENTIAL_REF,
		});
	}

	function resolverFor(product: ProductCase) {
		const resolver = registry.get(product.productId);
		if (resolver === undefined) {
			throw new Error(`no resolver for ${product.productId}`);
		}
		return resolver;
	}

	return {
		account,
		aws,
		async reconcile(product) {
			return resolverFor(product).reconcile(requestFor(product), transport);
		},
		async read(product) {
			const resolver = resolverFor(product);
			return resolver.read?.(requestFor(product), transport);
		},
		async remove(product) {
			await resolverFor(product).delete(requestFor(product), transport);
		},
	};
}

function hasTarget(request: TransportRequest, operation: string): boolean {
	return (request.headers["x-amz-target"] ?? "").endsWith(`.${operation}`);
}

function hasAction(request: TransportRequest, action: string): boolean {
	return formString(formParameters(request.body), "Action") === action;
}

const PRODUCTS: readonly ProductCase[] = [
	{
		label: "S3 bucket",
		productId: AWS_S3_PRODUCT_ID,
		slot: "bucket",
		logicalId: "hobo-orders",
		desired: { versioning: true, publicAccessBlocked: true },
		count: (account) => account.buckets.size,
		isCreate: (request) =>
			request.method === "PUT" && new URL(request.url).search === "",
	},
	{
		label: "DynamoDB table",
		productId: AWS_DYNAMODB_PRODUCT_ID,
		slot: "kv",
		logicalId: "hobo-sessions",
		desired: { billingMode: "on-demand", partitionKey: "sessionId" },
		count: (account) => account.tables.size,
		isCreate: (request) => hasTarget(request, "CreateTable"),
	},
	{
		label: "SQS standard queue",
		productId: AWS_SQS_PRODUCT_ID,
		slot: "queue",
		logicalId: "hobo-jobs",
		desired: { visibilityTimeoutSeconds: 45 },
		count: (account) => account.queues.size,
		isCreate: (request) => hasAction(request, "CreateQueue"),
	},
	{
		label: "SQS FIFO queue",
		productId: AWS_SQS_FIFO_PRODUCT_ID,
		slot: "queue",
		logicalId: "hobo-ordered",
		desired: {},
		count: (account) => account.queues.size,
		isCreate: (request) => hasAction(request, "CreateQueue"),
	},
	{
		label: "SNS topic",
		productId: AWS_SNS_PRODUCT_ID,
		slot: "topic",
		logicalId: "hobo-events",
		desired: {},
		count: (account) => account.topics.size,
		isCreate: (request) => hasAction(request, "CreateTopic"),
	},
	{
		label: "Secrets Manager secret",
		productId: AWS_SECRETS_MANAGER_PRODUCT_ID,
		slot: "secretRef",
		logicalId: "hobo-stripe",
		desired: { description: "payment provider key" },
		count: (account) => account.secrets.size,
		isCreate: (request) => hasTarget(request, "CreateSecret"),
	},
	{
		label: "SSM parameter",
		productId: AWS_SSM_PARAMETER_PRODUCT_ID,
		slot: "secretRef",
		logicalId: "hobo-endpoint",
		desired: { value: "https://api.example.com", tier: "standard" },
		count: (account) => account.parameters.size,
		isCreate: (request) => hasTarget(request, "PutParameter"),
	},
];

// ---------------------------------------------------------------------------
// Convergence — the property the whole module exists for
// ---------------------------------------------------------------------------

describe.each(PRODUCTS)("$label convergence", (product) => {
	it("creates the resource on the first reconcile", async () => {
		const runner = harness();
		const outcome = await runner.reconcile(product);

		expect(outcome.action).toBe("create");
		expect(outcome.physicalId.length).toBeGreaterThan(0);
		expect(product.count(runner.account)).toBe(1);
		// The outcome is what a caller records, so it has to survive core's
		// parse boundary — including its screen for credential-shaped keys.
		expect(parseResolveOutcome(outcome)).toBeDefined();
	});

	it("reconciles twice into one resource, one physicalId, and exactly one create call", async () => {
		const runner = harness();
		const first = await runner.reconcile(product);
		const second = await runner.reconcile(product);

		expect(product.count(runner.account)).toBe(1);
		expect(second.physicalId).toBe(first.physicalId);
		expect(second.action).not.toBe("create");
		expect(runner.aws.calls.filter(product.isCreate)).toHaveLength(1);
	});

	it("reads back what it created", async () => {
		const runner = harness();
		const created = await runner.reconcile(product);
		const observed = await runner.read(product);

		expect(observed?.physicalId).toBe(created.physicalId);
	});

	it("deletes the resource", async () => {
		const runner = harness();
		await runner.reconcile(product);
		await runner.remove(product);

		expect(product.count(runner.account)).toBe(0);
	});

	it("treats delete of an absent resource as success", async () => {
		const runner = harness();
		await expect(runner.remove(product)).resolves.toBeUndefined();
		expect(product.count(runner.account)).toBe(0);
	});

	it("reads nothing when the resource does not exist", async () => {
		const runner = harness();
		await expect(runner.read(product)).resolves.toBeUndefined();
	});

	it("never emits replace", async () => {
		const runner = harness();
		const first = await runner.reconcile(product);
		const second = await runner.reconcile(product);

		expect([first.action, second.action]).not.toContain("replace");
	});
});

// ---------------------------------------------------------------------------
// The credential law
// ---------------------------------------------------------------------------

describe("credentials never leave the authorization header", () => {
	it("sends the access key id only in authorization and the secret nowhere", async () => {
		const runner = harness();
		for (const product of PRODUCTS) await runner.reconcile(product);

		expect(runner.aws.calls.length).toBeGreaterThan(0);
		for (const call of runner.aws.calls) {
			const serialized = `${call.url}\n${call.body ?? ""}`;
			expect(serialized).not.toContain(CREDENTIALS.secretAccessKey);
			expect(serialized).not.toContain(CREDENTIALS.accessKeyId);
			for (const [name, value] of Object.entries(call.headers)) {
				if (value.includes(CREDENTIALS.accessKeyId)) {
					expect(name).toBe("authorization");
				}
				// SigV4 sends a signature derived from the secret, never the
				// secret; a transport carrying it would mean the signer leaked.
				expect(value).not.toContain(CREDENTIALS.secretAccessKey);
			}
			expect(call.headers.authorization).toContain("AWS4-HMAC-SHA256");
		}
	});

	it("keeps credential material out of every outcome", async () => {
		const runner = harness();
		for (const product of PRODUCTS) {
			const outcome = await runner.reconcile(product);
			const serialized = JSON.stringify(outcome);
			expect(serialized).not.toContain(CREDENTIALS.accessKeyId);
			expect(serialized).not.toContain(CREDENTIALS.secretAccessKey);
			expect(serialized).not.toContain(CREDENTIALS.sessionToken ?? "");
		}
	});

	it("signs the same request the same way twice, because the clock is injected", async () => {
		const first = harness();
		const second = harness();
		await first.reconcile(productAt(0));
		await second.reconcile(productAt(0));

		expect(second.aws.calls.map((call) => call.headers.authorization)).toEqual(
			first.aws.calls.map((call) => call.headers.authorization),
		);
	});
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** Vitest's `rejects` loses the typed code, so the refusal is caught by hand. */
async function refusal(run: () => Promise<void>): Promise<ResolverError> {
	try {
		await run();
	} catch (cause) {
		if (cause instanceof ResolverError) return cause;
		throw cause;
	}
	throw new Error("expected a ResolverError, but the call resolved");
}

function productAt(index: number): ProductCase {
	const product = PRODUCTS[index];
	if (product === undefined) {
		throw new Error(`expected product at ${index}`);
	}
	return product;
}

describe("refusals carry a typed code and no credential material", () => {
	const bucket = productAt(0);
	const table = productAt(1);
	const queue = productAt(2);

	it("turns an AWS error body into a redacted RESOLVER_PROVIDER_REJECTED", async () => {
		const runner = harness();
		runner.aws.stub(
			(request) => hasTarget(request, "DescribeTable"),
			jsonFault(
				403,
				"AccessDeniedException",
				`User: arn:aws:iam::${ACCOUNT}:user/deploy with key ${CREDENTIALS.accessKeyId} and secret ${CREDENTIALS.secretAccessKey} is not authorized`,
			),
		);

		const error = await refusal(() => runner.reconcile(table));

		expect(error.code).toBe("RESOLVER_PROVIDER_REJECTED");
		expect(error.message).not.toContain(CREDENTIALS.secretAccessKey);
		expect(error.message).not.toContain(CREDENTIALS.accessKeyId);
		expect(error.message).toContain("AccessDeniedException");
	});

	it("refuses an unparseable success body with RESOLVER_OUTPUT_UNPARSEABLE", async () => {
		const runner = harness();
		runner.aws.stub(
			(request) => hasTarget(request, "DescribeTable"),
			reply(200, "<html>a proxy sign-in page, not DynamoDB</html>"),
		);

		const error = await refusal(() => runner.reconcile(table));

		expect(error.code).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("refuses a success body missing the field that identifies the resource", async () => {
		const runner = harness();
		runner.aws.stub(
			(request) => hasAction(request, "CreateQueue"),
			reply(
				200,
				"<CreateQueueResponse><CreateQueueResult/></CreateQueueResponse>",
			),
		);

		const error = await refusal(() => runner.reconcile(queue));

		expect(error.code).toBe("RESOLVER_OUTPUT_UNPARSEABLE");
	});

	it("refuses a credentialRef that is not a locator", async () => {
		const registry = awsResolverRegistry({
			region: REGION,
			nowMs: NOW_MS,
			resolveCredential: async () => CREDENTIALS,
		});
		const resolver = registry.get(AWS_S3_PRODUCT_ID);
		const aws = createFakeAws(emptyAccount());

		const error = await refusal(async () =>
			resolver?.reconcile(
				{
					ref: {
						slot: "bucket",
						productId: AWS_S3_PRODUCT_ID,
						logicalId: "hobo-orders",
					},
					desired: {},
					credentialRef: "AKIAHOBOFAKEKEYID001",
				},
				guardedAwsTransport(aws.transport, REGION),
			),
		);

		expect(error.code).toBe("RESOLVER_CREDENTIAL_NOT_A_REF");
		expect(aws.calls).toHaveLength(0);
	});

	it("refuses an empty credentialRef before spending a call", async () => {
		const registry = awsResolverRegistry({
			region: REGION,
			nowMs: NOW_MS,
			resolveCredential: async () => CREDENTIALS,
		});
		const aws = createFakeAws(emptyAccount());

		const error = await refusal(async () =>
			registry.get(AWS_S3_PRODUCT_ID)?.reconcile(
				{
					ref: {
						slot: "bucket",
						productId: AWS_S3_PRODUCT_ID,
						logicalId: "hobo-orders",
					},
					desired: {},
					credentialRef: "   ",
				},
				guardedAwsTransport(aws.transport, REGION),
			),
		);

		expect(error.code).toBe("RESOLVER_CREDENTIAL_MISSING");
		expect(aws.calls).toHaveLength(0);
	});

	it("refuses a credential the host cannot resolve", async () => {
		const runner = harness(emptyAccount(), {
			accessKeyId: "",
			secretAccessKey: "",
		});

		const error = await refusal(() => runner.reconcile(bucket));

		expect(error.code).toBe("RESOLVER_CREDENTIAL_MISSING");
	});

	it("refuses a request handed to the wrong resolver", async () => {
		const registry = awsResolverRegistry({
			region: REGION,
			nowMs: NOW_MS,
			resolveCredential: async () => CREDENTIALS,
		});
		const aws = createFakeAws(emptyAccount());

		// The S3 resolver, handed a DynamoDB request: routing by hand instead of
		// through the registry is how a deploy calls an API nobody reviewed.
		const error = await refusal(async () =>
			registry.get(AWS_S3_PRODUCT_ID)?.reconcile(
				parseResolveRequest({
					ref: {
						slot: "kv",
						productId: AWS_DYNAMODB_PRODUCT_ID,
						logicalId: "hobo-sessions",
					},
					desired: {},
					credentialRef: CREDENTIAL_REF,
				}),
				guardedAwsTransport(aws.transport, REGION),
			),
		);

		expect(error.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(aws.calls).toHaveLength(0);
	});

	it("refuses a SecureString SSM parameter rather than carrying its value", async () => {
		const runner = harness();

		const error = await refusal(() =>
			runner.reconcile({
				...productAt(6),
				desired: { value: "hunter2", type: "SecureString" },
			}),
		);

		expect(error.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
		expect(error.message).toContain("SecureString");
	});

	it("refuses provisioned DynamoDB billing with no declared capacity", async () => {
		const runner = harness();

		const error = await refusal(() =>
			runner.reconcile({ ...table, desired: { billingMode: "provisioned" } }),
		);

		expect(error.code).toBe("RESOLVER_PRODUCT_UNSUPPORTED");
	});

	it("refuses a region it will not interpolate into a hostname", () => {
		expect(() =>
			awsResolverRegistry({
				region: "not a region",
				nowMs: NOW_MS,
				resolveCredential: async () => CREDENTIALS,
			}),
		).toThrow(/aws region/u);
	});
});

// ---------------------------------------------------------------------------
// Per-product behaviour worth pinning
// ---------------------------------------------------------------------------

describe("product-specific behaviour", () => {
	it("applies the S3 versioning and public-access deltas, then stops", async () => {
		const runner = harness();
		const created = await runner.reconcile(productAt(0));

		expect(created.action).toBe("create");
		expect(runner.account.buckets.get("hobo-orders")).toEqual({
			location: REGION,
			versioning: "Enabled",
			publicAccessBlocked: true,
		});

		// `adopt`, not `noop`: the request carried no physicalId, so the resolver
		// found a resource the caller did not know it owned. That distinction is
		// the audit record.
		const settled = await runner.reconcile(productAt(0));
		expect(settled.action).toBe("adopt");
		expect(settled.outputs.versioning).toBe("Enabled");
	});

	it("reports noop when the request already names the physical id", async () => {
		const runner = harness();
		await runner.reconcile(productAt(0));

		const registry = awsResolverRegistry({
			region: REGION,
			nowMs: NOW_MS,
			resolveCredential: async () => CREDENTIALS,
		});
		const outcome = await registry.get(AWS_S3_PRODUCT_ID)?.reconcile(
			parseResolveRequest({
				ref: {
					slot: "bucket",
					productId: AWS_S3_PRODUCT_ID,
					logicalId: "hobo-orders",
					physicalId: "hobo-orders",
				},
				desired: { versioning: true, publicAccessBlocked: true },
				credentialRef: CREDENTIAL_REF,
			}),
			guardedAwsTransport(runner.aws.transport, REGION),
		);

		expect(outcome?.action).toBe("noop");
	});

	it("reports immutable S3 region drift as a diagnostic rather than replacing", async () => {
		const account = emptyAccount();
		account.buckets.set("hobo-orders", {
			location: "eu-west-1",
			versioning: "Enabled",
			publicAccessBlocked: true,
		});
		const runner = harness(account);

		const outcome = await runner.reconcile(productAt(0));

		expect(outcome.action).not.toBe("replace");
		expect(outcome.diagnostics.join(" ")).toMatch(/immutable/u);
	});

	it("reports immutable DynamoDB key drift as a diagnostic rather than replacing", async () => {
		const account = emptyAccount();
		account.tables.set("hobo-sessions", {
			partitionKey: "id",
			billingMode: "PAY_PER_REQUEST",
		});
		const runner = harness(account);

		const outcome = await runner.reconcile(productAt(1));

		expect(outcome.action).not.toBe("replace");
		expect(outcome.diagnostics.join(" ")).toMatch(/immutable/u);
	});

	it("updates a DynamoDB billing mode in place", async () => {
		const account = emptyAccount();
		account.tables.set("hobo-sessions", {
			partitionKey: "sessionId",
			billingMode: "PROVISIONED",
		});
		const runner = harness(account);

		const outcome = await runner.reconcile(productAt(1));

		expect(outcome.action).toBe("update");
		expect(account.tables.get("hobo-sessions")?.billingMode).toBe(
			"PAY_PER_REQUEST",
		);
	});

	it("names a FIFO queue with the .fifo suffix AWS requires", async () => {
		const runner = harness();
		const outcome = await runner.reconcile(productAt(3));

		expect([...runner.account.queues.keys()]).toEqual(["hobo-ordered.fifo"]);
		expect(
			runner.account.queues.get("hobo-ordered.fifo")?.attributes.FifoQueue,
		).toBe("true");
		expect(outcome.outputs.fifo).toBe(true);
	});

	it("sets an SQS visibility timeout on create and converges without resetting it", async () => {
		const runner = harness();
		await runner.reconcile(productAt(2));

		expect(
			runner.account.queues.get("hobo-jobs")?.attributes.VisibilityTimeout,
		).toBe("45");

		await runner.reconcile(productAt(2));
		expect(
			runner.aws.calls.filter((call) => hasAction(call, "SetQueueAttributes")),
		).toHaveLength(0);
	});

	it("creates a Secrets Manager secret with no version, and says so", async () => {
		const runner = harness();
		const outcome = await runner.reconcile(productAt(5));

		const bodies = runner.aws.calls
			.filter((call) => hasTarget(call, "CreateSecret"))
			.map((call) => call.body ?? "");
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).not.toContain("SecretString");
		expect(outcome.outputs.arn).toMatch(/^arn:aws:secretsmanager:/u);
		expect(outcome.diagnostics.join(" ")).toMatch(/no version/u);
	});

	it("adopts a resource the request did not know about", async () => {
		const account = emptyAccount();
		account.topics.set("hobo-events", { attributes: {} });
		const runner = harness(account);

		const outcome = await runner.reconcile(productAt(4));

		expect(outcome.action).toBe("adopt");
		expect(account.topics.size).toBe(1);
	});

	it("diagnoses an S3 storage class it cannot apply", async () => {
		const runner = harness();
		const outcome = await runner.reconcile({
			...productAt(0),
			desired: { storageClass: "intelligent-tiering" },
		});

		expect(outcome.diagnostics.join(" ")).toMatch(/storageClass/u);
	});
});

// ---------------------------------------------------------------------------
// Coverage is a declaration, not an accident
// ---------------------------------------------------------------------------

describe("catalog coverage", () => {
	/** Every product id the AWS Yard catalog offers. */
	function catalogProductIds(): readonly string[] {
		const ids = new Set<string>();
		for (const entries of Object.values(AWS_DEFAULT_BINDINGS)) {
			for (const binding of entries ?? []) {
				if (binding.productId !== undefined) ids.add(binding.productId);
			}
		}
		return [...ids].sort();
	}

	it("resolves exactly the catalog products that are not declared unresolved", () => {
		const uncovered = catalogProductIds().filter(
			(id) => !AWS_RESOLVED_PRODUCT_IDS.includes(id),
		);

		expect(uncovered).toEqual([...AWS_UNRESOLVED_PRODUCT_IDS]);
	});

	it("declares no unresolved id that it also resolves", () => {
		for (const id of AWS_UNRESOLVED_PRODUCT_IDS) {
			expect(AWS_RESOLVED_PRODUCT_IDS).not.toContain(id);
		}
	});

	it("registers one resolver per resolved product, id-sorted", () => {
		const registry = awsResolverRegistry({
			region: REGION,
			nowMs: NOW_MS,
			resolveCredential: async () => CREDENTIALS,
		});

		expect(registry.list().map((resolver) => resolver.productId)).toEqual([
			...AWS_RESOLVED_PRODUCT_IDS,
		]);
		for (const resolver of registry.list()) {
			expect(resolver.providerId).toBe("aws");
		}
	});
});
