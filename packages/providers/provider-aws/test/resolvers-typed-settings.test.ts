// Every `desired` setting an AWS resolver reads has a type, and every member
// of a provider's JSON answer it reads has one too. A value of another type
// must be refused, never read as absent:
//
//  - A `desired` setting of the wrong type is the declaration's mistake. It is
//    RESOLVER_PRODUCT_UNSUPPORTED, worded "<id>: desired.<key> must be …,
//    received …", and it is refused before any call. Read loosely,
//    `versioning: "true"` would leave a bucket unversioned and report nothing.
//  - A member of the answer with the wrong type is the provider's fault. It is
//    RESOLVER_OUTPUT_UNPARSEABLE, as every answer this file cannot read is.
//    Read loosely, a `Description` of 5 would read as "no description" and
//    reconcile would overwrite the real one.
//
// Absent stays absent: the other suites run every product with no settings.
// HONEST SCOPE: the transport is a fake that answers fixed bodies.
import {
	type HttpTransport,
	parseResolveRequest,
	ResolverError,
	type TransportRequest,
	type TransportResponse,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	AWS_DYNAMODB_PRODUCT_ID,
	AWS_S3_PRODUCT_ID,
	AWS_SECRETS_MANAGER_PRODUCT_ID,
	AWS_SNS_PRODUCT_ID,
	AWS_SQS_FIFO_PRODUCT_ID,
	AWS_SQS_PRODUCT_ID,
	AWS_SSM_PARAMETER_PRODUCT_ID,
	awsResolverRegistry,
	guardedAwsTransport,
} from "../src/index.js";
import type { JsonObject, JsonValue } from "../src/json.js";

const REGION = "us-east-1";
const NAME = "hobo-typed";

function resolverFor(productId: string) {
	const resolver = awsResolverRegistry({
		region: REGION,
		nowMs: Date.parse("2026-03-04T05:06:07.000Z"),
		resolveCredential: async () => ({
			accessKeyId: "AKIAHOBOFAKEKEYID001",
			secretAccessKey: "n0tARealSecretAccessKey0000000000000000x",
		}),
	}).get(productId);
	if (resolver === undefined) throw new Error(`no resolver for ${productId}`);
	return resolver;
}

function requestFor(productId: string, desired: JsonObject) {
	return parseResolveRequest({
		ref: { slot: "data", productId, logicalId: NAME },
		desired,
		credentialRef: "secret://camp/aws-deploy",
	});
}

/** The refusal a call ended in, or undefined when it did not refuse. */
async function refusalOf(
	call: Promise<unknown> | undefined,
): Promise<Error | undefined> {
	return (call ?? Promise.resolve()).then(
		() => undefined,
		(error: Error) => error,
	);
}

const TYPE_NAMES = {
	boolean: "a boolean (true or false)",
	integer: "an integer",
	string: "a string",
} as const;

// One row per setting each resolver reads: the product, the key, a value of
// the wrong type, and the type it must have.
const SETTINGS: readonly (readonly [
	string,
	string,
	JsonValue,
	keyof typeof TYPE_NAMES,
])[] = [
	[AWS_S3_PRODUCT_ID, "name", 7, "string"],
	[AWS_S3_PRODUCT_ID, "versioning", "true", "boolean"],
	[AWS_S3_PRODUCT_ID, "publicAccessBlocked", 1, "boolean"],
	[AWS_S3_PRODUCT_ID, "storageClass", 5, "string"],
	[AWS_DYNAMODB_PRODUCT_ID, "billingMode", true, "string"],
	[AWS_DYNAMODB_PRODUCT_ID, "readCapacity", "5", "integer"],
	[AWS_DYNAMODB_PRODUCT_ID, "writeCapacity", 1.5, "integer"],
	[AWS_DYNAMODB_PRODUCT_ID, "partitionKey", 1, "string"],
	[AWS_DYNAMODB_PRODUCT_ID, "partitionKeyType", ["S"], "string"],
	[AWS_DYNAMODB_PRODUCT_ID, "sortKey", null, "string"],
	[AWS_DYNAMODB_PRODUCT_ID, "sortKeyType", false, "string"],
	[AWS_SQS_PRODUCT_ID, "fifo", "true", "boolean"],
	[AWS_SQS_PRODUCT_ID, "visibilityTimeoutSeconds", "30", "integer"],
	[AWS_SQS_PRODUCT_ID, "maxReceiveCount", 2.5, "integer"],
	[AWS_SQS_FIFO_PRODUCT_ID, "fifo", 1, "boolean"],
	[AWS_SNS_PRODUCT_ID, "fifo", "true", "boolean"],
	[AWS_SNS_PRODUCT_ID, "contentBasedDeduplication", "yes", "boolean"],
	[AWS_SECRETS_MANAGER_PRODUCT_ID, "description", 5, "string"],
	[AWS_SECRETS_MANAGER_PRODUCT_ID, "kmsKeyRef", { id: "k" }, "string"],
	[AWS_SECRETS_MANAGER_PRODUCT_ID, "rotationDays", "30", "integer"],
	[AWS_SSM_PARAMETER_PRODUCT_ID, "type", 1, "string"],
	[AWS_SSM_PARAMETER_PRODUCT_ID, "tier", true, "string"],
	[AWS_SSM_PARAMETER_PRODUCT_ID, "kmsKeyRef", 5, "string"],
	[AWS_SSM_PARAMETER_PRODUCT_ID, "value", 5, "string"],
];

describe("a desired setting of the wrong type", () => {
	it.each(
		SETTINGS,
	)("%s desired.%s = %o is refused by read, reconcile and delete, before any call", async (productId, key, value, type) => {
		const calls: TransportRequest[] = [];
		const transport: HttpTransport = async (request) => {
			calls.push(request);
			throw new Error("no call may be made");
		};
		const resolver = resolverFor(productId);
		const request = requestFor(productId, { [key]: value });

		for (const call of [
			resolver.read?.(request, transport),
			resolver.reconcile(request, transport),
			resolver.delete(request, transport),
		]) {
			const refusal = await refusalOf(call);
			expect(refusal).toBeInstanceOf(ResolverError);
			expect(refusal instanceof ResolverError ? refusal.code : "").toBe(
				"RESOLVER_PRODUCT_UNSUPPORTED",
			);
			expect(refusal?.message).toBe(
				`${productId}: desired.${key} must be ${TYPE_NAMES[type]}, received ${JSON.stringify(value)}`,
			);
		}
		expect(calls).toEqual([]);
	});
});

/** A provider that answers every call with the body its operation maps to. */
function answering(bodies: Readonly<Record<string, JsonObject>>) {
	const operations: string[] = [];
	async function transport(
		request: TransportRequest,
	): Promise<TransportResponse> {
		const operation =
			(request.headers["x-amz-target"] ?? "").split(".")[1] ?? "";
		operations.push(operation);
		const body = bodies[operation];
		if (body === undefined) throw new Error(`unexpected call ${operation}`);
		return { status: 200, headers: {}, body: JSON.stringify(body) };
	}
	return { transport: guardedAwsTransport(transport, REGION), operations };
}

const TABLE_ARN = `arn:aws:dynamodb:${REGION}:123456789012:table/${NAME}`;
const SECRET_ARN = `arn:aws:secretsmanager:${REGION}:123456789012:secret:${NAME}-AbCdEf`;
const PARAMETER_ARN = `arn:aws:ssm:${REGION}:123456789012:parameter/${NAME}`;

function table(members: JsonObject): JsonObject {
	return { Table: { TableName: NAME, TableArn: TABLE_ARN, ...members } };
}

// One row per member of a JSON answer the resolvers read: what is called, the
// answers, the member, and its wrong type as the refusal names it.
const ANSWERS: readonly (readonly [
	string,
	string,
	"read" | "reconcile",
	JsonObject,
	Readonly<Record<string, JsonObject>>,
	string,
	string,
])[] = [
	[
		AWS_DYNAMODB_PRODUCT_ID,
		"the table",
		"read",
		{},
		{ DescribeTable: { Table: "t" } },
		"Table",
		"a string, not an object",
	],
	[
		AWS_DYNAMODB_PRODUCT_ID,
		"the table ARN",
		"read",
		{},
		{ DescribeTable: table({ TableArn: 5 }) },
		"TableArn",
		"a number, not a string",
	],
	[
		AWS_DYNAMODB_PRODUCT_ID,
		"the table status",
		"read",
		{},
		{ DescribeTable: table({ TableStatus: 5 }) },
		"TableStatus",
		"a number, not a string",
	],
	[
		AWS_DYNAMODB_PRODUCT_ID,
		"the billing summary",
		"read",
		{},
		{ DescribeTable: table({ BillingModeSummary: "x" }) },
		"BillingModeSummary",
		"a string, not an object",
	],
	[
		AWS_DYNAMODB_PRODUCT_ID,
		"the billing mode",
		"read",
		{},
		{ DescribeTable: table({ BillingModeSummary: { BillingMode: 1 } }) },
		"BillingMode",
		"a number, not a string",
	],
	[
		AWS_DYNAMODB_PRODUCT_ID,
		"the key schema",
		"read",
		{},
		{ DescribeTable: table({ KeySchema: "pk" }) },
		"KeySchema",
		"a string, not an array",
	],
	[
		AWS_DYNAMODB_PRODUCT_ID,
		"the partition key's name",
		"read",
		{},
		{
			DescribeTable: table({
				KeySchema: [{ KeyType: "HASH", AttributeName: 1 }],
			}),
		},
		"AttributeName",
		"a number, not a string",
	],
	[
		AWS_DYNAMODB_PRODUCT_ID,
		"the updated table",
		"reconcile",
		{ billingMode: "provisioned", readCapacity: 5, writeCapacity: 5 },
		{
			DescribeTable: table({
				BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
			}),
			UpdateTable: { TableDescription: "t" },
		},
		"TableDescription",
		"a string, not an object",
	],
	[
		AWS_SECRETS_MANAGER_PRODUCT_ID,
		"the ARN",
		"read",
		{},
		{ DescribeSecret: { ARN: 5, Name: NAME } },
		"ARN",
		"a number, not a string",
	],
	[
		AWS_SECRETS_MANAGER_PRODUCT_ID,
		"the description",
		"read",
		{},
		{ DescribeSecret: { ARN: SECRET_ARN, Name: NAME, Description: 5 } },
		"Description",
		"a number, not a string",
	],
	[
		AWS_SECRETS_MANAGER_PRODUCT_ID,
		"the KMS key",
		"read",
		{},
		{ DescribeSecret: { ARN: SECRET_ARN, Name: NAME, KmsKeyId: ["k"] } },
		"KmsKeyId",
		"an array, not a string",
	],
	[
		AWS_SECRETS_MANAGER_PRODUCT_ID,
		"the description reconcile compares",
		"reconcile",
		{ description: "payment provider key" },
		{ DescribeSecret: { ARN: SECRET_ARN, Name: NAME, Description: true } },
		"Description",
		"a boolean, not a string",
	],
	[
		AWS_SSM_PARAMETER_PRODUCT_ID,
		"the parameter",
		"read",
		{},
		{ GetParameter: { Parameter: 5 } },
		"Parameter",
		"a number, not an object",
	],
	[
		AWS_SSM_PARAMETER_PRODUCT_ID,
		"the parameter ARN",
		"read",
		{},
		{ GetParameter: { Parameter: { Name: NAME, ARN: 5 } } },
		"ARN",
		"a number, not a string",
	],
	[
		AWS_SSM_PARAMETER_PRODUCT_ID,
		"the parameter type",
		"read",
		{},
		{
			GetParameter: { Parameter: { Name: NAME, ARN: PARAMETER_ARN, Type: 5 } },
		},
		"Type",
		"a number, not a string",
	],
	[
		AWS_SSM_PARAMETER_PRODUCT_ID,
		"the value reconcile compares",
		"reconcile",
		{ value: "v" },
		{
			GetParameter: {
				Parameter: { Name: NAME, ARN: PARAMETER_ARN, Type: "String", Value: 5 },
			},
		},
		"Value",
		"a number, not a string",
	],
];

describe("a member of a provider's answer of the wrong type", () => {
	it.each(
		ANSWERS,
	)("%s: %s is refused as unparseable on %s", async (productId, _what, verb, desired, bodies, member, wrongType) => {
		const provider = answering(bodies);
		const resolver = resolverFor(productId);
		const request = requestFor(productId, desired);

		const refusal = await refusalOf(
			verb === "read"
				? resolver.read?.(request, provider.transport)
				: resolver.reconcile(request, provider.transport),
		);

		expect(refusal).toBeInstanceOf(ResolverError);
		expect(refusal instanceof ResolverError ? refusal.code : "").toBe(
			"RESOLVER_OUTPUT_UNPARSEABLE",
		);
		expect(refusal?.message).toContain(
			`AWS answered "${member}" with ${wrongType}`,
		);
		// Nothing is created, put or deleted after an answer that could not be read.
		expect(
			provider.operations.filter((operation) =>
				/^(Create|Put|Delete)/u.test(operation),
			),
		).toEqual([]);
	});

	it("still reads an absent or null member as absent", async () => {
		const provider = answering({
			DescribeSecret: {
				ARN: SECRET_ARN,
				Name: NAME,
				Description: null,
			},
		});
		const resolver = resolverFor(AWS_SECRETS_MANAGER_PRODUCT_ID);

		const observed = await resolver.read?.(
			requestFor(AWS_SECRETS_MANAGER_PRODUCT_ID, {}),
			provider.transport,
		);

		expect(observed?.outputs).toEqual({ name: NAME, arn: SECRET_ARN });
	});

	it("reads a null object member as absent", async () => {
		const provider = answering({
			DescribeTable: table({ TableStatus: "ACTIVE", BillingModeSummary: null }),
		});
		const resolver = resolverFor(AWS_DYNAMODB_PRODUCT_ID);

		const observed = await resolver.read?.(
			requestFor(AWS_DYNAMODB_PRODUCT_ID, {}),
			provider.transport,
		);

		expect(observed?.outputs).toEqual({
			tableName: NAME,
			tableArn: TABLE_ARN,
			tableStatus: "ACTIVE",
		});
	});

	it.each([
		["", "empty"],
		["   ", "only spaces"],
	])("reads a blank string member (%o, %s) as absent, as optionalString did", async (blank) => {
		const provider = answering({
			DescribeSecret: { ARN: SECRET_ARN, Name: NAME, Description: blank },
		});
		const resolver = resolverFor(AWS_SECRETS_MANAGER_PRODUCT_ID);

		const observed = await resolver.read?.(
			requestFor(AWS_SECRETS_MANAGER_PRODUCT_ID, {}),
			provider.transport,
		);

		expect(observed?.outputs).toEqual({ name: NAME, arn: SECRET_ARN });
	});
});
