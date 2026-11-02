import { fromJsonString } from "@bufbuild/protobuf";
import { type Configuration, ConfigurationSchema } from "./_generated/ci_pb.js";
import {
	validateSandboxAllowance,
	validateSandboxPricing,
} from "./sandbox-pricing.js";

export function parseConfiguration(json: string): Configuration {
	const config = fromJsonString(ConfigurationSchema, json);
	const accountIds = new Set<string>();
	const entitlements = new Set<string>();
	const repositories = new Set<number>();
	for (const account of config.accounts) {
		if (!/^[a-zA-Z0-9_-]{1,80}$/.test(account.id) || accountIds.has(account.id))
			throw new Error("invalid or duplicate account");
		accountIds.add(account.id);
		micros(account.budgetMicros, account.spentMicros);
		const signalKeys = Object.keys(account.routingSignalCycles);
		if (
			signalKeys.length !== Object.keys(account.routingSignalCrossed).length ||
			signalKeys.some(
				(key) =>
					!key.startsWith("broker:") ||
					key.length > 300 ||
					!Object.hasOwn(account.routingSignalCrossed, key) ||
					(account.routingSignalCycles[key] ?? 0) < 1,
			)
		)
			throw new Error("invalid routing signal state");
		if (
			account.usageObservedAt &&
			!Number.isFinite(Date.parse(account.usageObservedAt))
		)
			throw new Error("invalid account usage snapshot");
		if (
			!Number.isInteger(account.maxRuntimeMinutes) ||
			account.maxRuntimeMinutes < 1 ||
			account.maxRuntimeMinutes > 330 ||
			account.startupMinutes < 1 ||
			account.startupMinutes > 20
		)
			throw new Error("invalid host timeout");
		const ids = new Set<string>();
		for (const offer of account.offers) {
			if (!/^[a-zA-Z0-9_-]{1,80}$/.test(offer.id) || ids.has(offer.id))
				throw new Error("invalid or duplicate offer");
			ids.add(offer.id);
			if (
				!["", "gh-actions", "dagger", "cf", "sandbox", "ado", "isolated-container"].includes(
					offer.backend,
				)
			)
				throw new Error("unsupported execution backend");
			if (
				(offer.provider === "azure-devops" && offer.backend !== "ado") ||
				(offer.backend === "ado" && offer.provider !== "azure-devops") ||
				(offer.provider === "dagger" && offer.backend !== "dagger") ||
				(offer.provider === "cloudflare" && offer.backend !== "cf") ||
				(offer.provider === "vercel" && offer.backend !== "sandbox") ||
				(offer.backend === "sandbox" && offer.provider !== "vercel") ||
				(((offer.provider === "kubernetes" ||
					offer.provider === "hobo-box-worker") &&
					offer.backend !== "isolated-container") ||
				(offer.backend === "isolated-container" &&
					offer.provider !== "kubernetes" &&
					offer.provider !== "hobo-box-worker"))
			)
				throw new Error(
					"native provider requires its matching execution backend",
				);
			if (
				![
					"github",
					"blacksmith",
					"depot",
					"warpbuild",
					"kubernetes",
					"hobo-box-worker",
					"local",
					"dagger",
					"cloudflare",
					"vercel",
					"azure-devops",
				].includes(offer.provider)
			)
				throw new Error("unsupported provider");
			if (
				offer.provider === "local" &&
				(offer.backend !== "gh-actions" ||
					offer.runsOn !== "hobo-local-host" ||
					offer.concurrency !== 1 ||
					offer.freeMinutes !== 0 ||
					offer.priceMicrosPerMinute !== 0)
			)
				throw new Error(
					"local provider requires one zero-price gh-actions workstation on hobo-local-host without free-minute credits",
				);
			if (offer.backend === "isolated-container") {
				if (
					offer.provider !== "kubernetes" ||
					offer.runsOn !== "hobo-isolated-worker" ||
					offer.freeMinutes !== 0 ||
					offer.priceMicrosPerMinute !== 0 ||
					offer.budgetMicros !== 0 ||
					offer.sandboxPricing ||
					offer.sandboxAllowance
				)
					throw new Error(
						"isolated-container requires a zero-price kubernetes worker offer without sandbox pricing",
					);
			}
			if (offer.backend === "sandbox") {
				if (!offer.sandboxPricing || offer.freeMinutes !== 0)
					throw new Error(
						"sandbox requires a rate card and no unmodeled free allocation",
					);
				validateSandboxPricing(offer.sandboxPricing);
				if (
					offer.sandboxPricing.proxyVmRequired &&
					offer.priceMicrosPerMinute !== 0
				)
					throw new Error(
						"two-VM direct Sandbox cannot claim an unmetered host rate",
					);
				if (offer.sandboxAllowance)
					validateSandboxAllowance(offer.sandboxAllowance);
			} else if (offer.sandboxPricing || offer.sandboxAllowance) {
				throw new Error("sandbox pricing requires sandbox backend");
			}
			micros(offer.priceMicrosPerMinute, offer.budgetMicros, offer.spentMicros);
			const key = `${offer.provider}:${offer.providerAccountId}`;
			if (!offer.providerAccountId || entitlements.has(key))
				throw new Error(
					"provider account entitlement must have one owner and one offer",
				);
			entitlements.add(key);
			nonnegative(
				offer.freeMinutes,
				offer.priceMicrosPerMinute,
				offer.budgetMicros,
				offer.spentMicros,
			);
			if (
				offer.concurrency < 1 ||
				offer.concurrency > 1000 ||
				!Number.isFinite(Date.parse(offer.observedAt)) ||
				!Number.isFinite(Date.parse(offer.validUntil)) ||
				Date.parse(offer.validUntil) <= Date.parse(offer.observedAt)
			)
				throw new Error("invalid offer evidence");
			if (
				!/^[a-zA-Z0-9_.-]{1,100}$/.test(offer.runsOn) ||
				offer.runsOn.toLowerCase() === "hobo"
			)
				throw new Error("invalid bridge runner label");
			if (!offer.sourceUrl.startsWith("https://"))
				throw new Error("offer evidence source must use HTTPS");
		}
	}
	for (const connection of config.connections) {
		if (!connection.trustedRepositoryAcknowledged)
			throw new Error(
				"trusted repository acknowledgment required: all hobo workflows share runner access",
			);
		if (
			!accountIds.has(connection.accountId) ||
			repositories.has(connection.repositoryId)
		)
			throw new Error("repository must belong to one configured account");
		repositories.add(connection.repositoryId);
		if (
			!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(connection.repository) ||
			connection.repository.split("/").some((p) => p === "." || p === "..")
		)
			throw new Error("invalid repository");
		positiveId(
			connection.repositoryId,
			connection.installationId,
			connection.runnerGroupId,
		);
		if (connection.isolatedOnly) {
			if (
				!connection.acceptAllMatchingRepositoryJobs ||
				!connection.publicRepositoryAcknowledged ||
				connection.allowAllPullRequests ||
				connection.allowedEvents.length !== 0 ||
				connection.allowedRefs.length !== 0
			)
				throw new Error(
					"isolated connection requires consent to all repository jobs and public repository acknowledgment, without event or ref filters",
				);
			if (
				connection.bridgeWorkflow ||
				connection.bridgeSha ||
				connection.bridgeRef ||
				connection.dispatcherActorId !== 0
			)
				throw new Error("isolated connection cannot specify a workflow bridge");
		} else {
			if (connection.acceptAllMatchingRepositoryJobs)
				throw new Error(
					"accepting all repository jobs requires isolated-only mode",
				);
			positiveId(connection.dispatcherActorId);
			if (!/^[a-zA-Z0-9_/-]{1,100}$/.test(connection.bridgeRef))
				throw new Error("protected bridge branch or tag ref required");
			if (
				!/^[a-zA-Z0-9_-]+\.ya?ml$/.test(connection.bridgeWorkflow) ||
				!/^[a-f0-9]{40}$/.test(connection.bridgeSha)
			)
				throw new Error("bridge workflow requires a pinned commit SHA");
		}
		if (
			!connection.isolatedOnly &&
			(connection.allowedEvents.length === 0 ||
				connection.allowedEvents.some(
					(event) =>
						!["push", "workflow_dispatch", "pull_request"].includes(event),
				) ||
				connection.allowedRefs.length === 0 ||
				connection.allowedRefs.some((ref) => !ref.startsWith("refs/heads/")))
		)
			throw new Error("explicit trusted branch and event allowlists required");
	}
	return config;
}

export function nonnegative(...values: number[]): void {
	if (
		values.some(
			(value) =>
				!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER,
		)
	)
		throw new Error("expected finite nonnegative quantity");
}
export function positiveId(...values: number[]): void {
	if (values.some((value) => !Number.isSafeInteger(value) || value <= 0))
		throw new Error("expected positive safe integer id");
}

function micros(...values: number[]): void {
	nonnegative(...values);
	if (values.some((value) => !Number.isSafeInteger(value)))
		throw new Error("cost must be integer USD microdollars");
}
