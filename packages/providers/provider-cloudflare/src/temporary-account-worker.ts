/**
 * Upload a Worker with a Durable Object to a temporary account, with the
 * account's own token, over the same injected transport as the account's
 * creation (no global `fetch`, `api.cloudflare.com` only).
 *
 * Cloudflare's "Supported resources" table lists Workers ("Deployments on
 * workers.dev") and Durable Objects ("Deploy Workers with Durable Object
 * bindings and migrations"), so both are gated through the allowlist first.
 * The script is one multipart upload (`PUT /accounts/{id}/workers/scripts/
 * {name}`): a `metadata` part naming the main module, the compatibility
 * date, the Durable Object namespace binding, plain-text variables, and the
 * migration that creates the class as SQLite-backed (`new_sqlite_classes`,
 * the only Durable Object backend the Workers Free plan offers); then one
 * part per ES module. Then the script's workers.dev route is enabled and the
 * account's workers.dev subdomain read, which together give the Worker's
 * origin.
 *
 * Verified from documentation, not observed: the claim-deployments page
 * documents the upload endpoint with `main_module` and `compatibility_date`
 * and the subdomain read; the binding and migration fields are the Workers
 * script-upload metadata (`bindings[].type: "durable_object_namespace"`,
 * `migrations.new_tag` / `new_sqlite_classes`). That the temporary token
 * accepts a migration on upload is what the supported-resources row says;
 * no request has been made from this repository.
 */
import { randomBytes } from "node:crypto";
import { isJsonString } from "./json.js";
import {
	assertLeaseActive,
	CLOUDFLARE_TEMPORARY_ACCOUNT_API_BASE,
	callCloudflare,
	type TemporaryAccountTransportPort,
	type TemporaryAccountYardReceipt,
} from "./temporary-account.js";
import type { SecretCustodyLendingPort } from "./temporary-account-custody.js";
import { TemporaryAccountError } from "./temporary-account-errors.js";
import { assertTemporaryAccountResourceAllowed } from "./temporary-account-resources.js";

export type TemporaryWorkerModule = Readonly<{ name: string; source: string }>;

export type DurableObjectWorkerUpload = Readonly<{
	scriptName: string;
	mainModule: string;
	modules: readonly TemporaryWorkerModule[];
	compatibilityDate: string;
	durableObject: Readonly<{
		binding: string;
		className: string;
		migrationTag: string;
	}>;
	/** Non-secret variables only: temporary accounts list no secret bindings. */
	plainText: Readonly<Record<string, string>>;
}>;

export type TemporaryWorkerDeployment = Readonly<{
	scriptName: string;
	workersDevUrl: string;
}>;

const SCRIPT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const MODULE_NAME = /^[a-z][a-z0-9-]*\.js$/u;
const BINDING_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const CLASS_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/u;
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
/** The script upload's request ceiling; the Worker is a few tens of KiB. */
export const MAX_WORKER_UPLOAD_BYTES = 1_048_576;

function refuse(message: string, reason: string): never {
	throw new TemporaryAccountError("RESOURCE_NOT_SUPPORTED", message, {
		reason,
	});
}

export type WorkerUploadBody = Readonly<{
	contentType: string;
	body: string;
	metadata: string;
}>;

/** The multipart body, its content type and its metadata part. */
export function workerUploadBody(
	upload: DurableObjectWorkerUpload,
	boundary = randomBytes(16).toString("hex"),
): WorkerUploadBody {
	if (!SCRIPT_NAME.test(upload.scriptName))
		refuse(
			"the Worker's script name is not a workers.dev label",
			"INVALID_SCRIPT_NAME",
		);
	const names = upload.modules.map((module) => module.name);
	if (
		names.length === 0 ||
		new Set(names).size !== names.length ||
		!names.every((name) => MODULE_NAME.test(name)) ||
		!names.includes(upload.mainModule)
	)
		refuse(
			"the Worker's modules must be distinct .js names including the main module",
			"INVALID_MODULES",
		);
	const { binding, className, migrationTag } = upload.durableObject;
	if (
		!BINDING_NAME.test(binding) ||
		!CLASS_NAME.test(className) ||
		!/^v\d{1,4}$/u.test(migrationTag)
	)
		refuse(
			"the Durable Object binding, class or migration tag is malformed",
			"INVALID_DURABLE_OBJECT",
		);
	const plain = Object.entries(upload.plainText);
	if (plain.some(([name]) => !BINDING_NAME.test(name) || name === binding))
		refuse(
			"a plain-text variable name is malformed or shadows the Durable Object binding",
			"INVALID_VARIABLE",
		);
	const metadata = JSON.stringify({
		main_module: upload.mainModule,
		compatibility_date: upload.compatibilityDate,
		bindings: [
			{
				type: "durable_object_namespace",
				name: binding,
				class_name: className,
			},
			...plain.map(([name, text]) => ({ type: "plain_text", name, text })),
		],
		migrations: { new_tag: migrationTag, new_sqlite_classes: [className] },
	});
	const parts = [
		{
			name: "metadata",
			filename: "metadata.json",
			type: "application/json",
			content: metadata,
		},
		...upload.modules.map((module) => ({
			name: module.name,
			filename: module.name,
			type: "application/javascript+module",
			content: module.source,
		})),
	];
	if (parts.some((part) => part.content.includes(boundary)))
		refuse(
			"the multipart boundary occurs in the content",
			"BOUNDARY_COLLISION",
		);
	const body = `${parts
		.map(
			(part) =>
				`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.type}\r\n\r\n${part.content}\r\n`,
		)
		.join("")}--${boundary}--\r\n`;
	if (Buffer.byteLength(body, "utf8") > MAX_WORKER_UPLOAD_BYTES)
		refuse("the Worker upload exceeds its byte ceiling", "UPLOAD_TOO_LARGE");
	return {
		contentType: `multipart/form-data; boundary=${boundary}`,
		body,
		metadata,
	};
}

/**
 * Upload the Worker, enable its workers.dev route, and return its origin.
 * The account's token is lent by custody for these three calls only.
 */
export async function uploadTemporaryAccountWorker(input: {
	readonly transport: TemporaryAccountTransportPort;
	readonly custody: SecretCustodyLendingPort;
	readonly receipt: TemporaryAccountYardReceipt;
	readonly upload: DurableObjectWorkerUpload;
	readonly nowMs: number;
}): Promise<TemporaryWorkerDeployment> {
	assertLeaseActive(input.receipt.lease, input.nowMs);
	assertTemporaryAccountResourceAllowed("workers");
	assertTemporaryAccountResourceAllowed("durable-objects");
	const { contentType, body } = workerUploadBody(input.upload);
	const account = encodeURIComponent(input.receipt.accountId);
	const script = encodeURIComponent(input.upload.scriptName);
	const base = `${CLOUDFLARE_TEMPORARY_ACCOUNT_API_BASE}/accounts/${account}/workers`;
	return input.custody.lend(input.receipt.apiTokenRef, async (token) => {
		const authorization = `Bearer ${token}`;
		await callCloudflare(
			input.transport,
			{
				method: "PUT",
				url: `${base}/scripts/${script}`,
				headers: { authorization, "content-type": contentType },
				body,
			},
			{ stage: "worker upload", mutating: true },
		);
		const route = await callCloudflare(
			input.transport,
			{
				method: "POST",
				url: `${base}/scripts/${script}/subdomain`,
				headers: { authorization, "content-type": "application/json" },
				body: JSON.stringify({ enabled: true }),
			},
			{ stage: "workers.dev route", mutating: true },
		);
		if (route.enabled !== true)
			throw new TemporaryAccountError(
				"PROVIDER_CONTRACT_CHANGED",
				"cloudflare did not confirm the workers.dev route",
				{ reason: "ROUTE_NOT_ENABLED" },
			);
		const subdomain = await callCloudflare(
			input.transport,
			{ method: "GET", url: `${base}/subdomain`, headers: { authorization } },
			{ stage: "workers.dev subdomain", mutating: false },
		);
		const host = subdomain.subdomain;
		if (!isJsonString(host) || !SUBDOMAIN.test(host))
			throw new TemporaryAccountError(
				"PROVIDER_CONTRACT_CHANGED",
				"cloudflare reported no valid workers.dev subdomain",
				{ reason: "MISSING_SUBDOMAIN" },
			);
		return Object.freeze({
			scriptName: input.upload.scriptName,
			workersDevUrl: `https://${input.upload.scriptName}.${host}.workers.dev`,
		});
	});
}
