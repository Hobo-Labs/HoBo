import { createSign } from "node:crypto";
import { z } from "zod";
import { createGithubAppManifest } from "./onboarding.js";

const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const App = z.object({
	id: Id,
	slug: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
	owner: z.object({ id: Id, type: z.enum(["User", "Organization"]) }),
	external_url: z.string().url(),
	permissions: z.record(z.string(), z.string()),
	events: z.array(z.string()).max(100),
});
const Hook = z.object({
	url: z.string().url(),
	content_type: z.literal("json"),
	insecure_ssl: z.literal("0"),
});

type GithubAppVerificationOptions = {
	appId: number;
	pem: string;
	expectedOrigin: string;
	expectedOwnerId: number;
	expectedOwnerType?: "User" | "Organization";
	fetch?: typeof fetch;
	now?: () => number;
};

export async function verifyConvertedGithubApp(
	options: GithubAppVerificationOptions & { metadata: unknown },
): Promise<void> {
	await verifyGithubApp(options, App.parse(options.metadata));
}

export async function verifyStoredGithubApp(
	options: GithubAppVerificationOptions,
): Promise<void> {
	await verifyGithubApp(options);
}

async function verifyGithubApp(
	options: GithubAppVerificationOptions,
	converted?: z.infer<typeof App>,
): Promise<void> {
	const appId = Id.parse(options.appId);
	const ownerId = Id.parse(options.expectedOwnerId);
	const origin = new URL(options.expectedOrigin);
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash
	)
		throw new Error("invalid expected App origin");
	const expected = createGithubAppManifest({
		name: "HoBo CI",
		relayUrl: origin.origin,
		manifestCallbackUrl: `${origin.origin}/v1/app-bootstrap/callback`,
		installationCallbackUrl: `${origin.origin}/v1/app-registration/install-callback`,
	});
	const expectedPermissions = Object.entries(
		expected.defaultPermissions,
	).sort();
	const expectedEvents = [...expected.defaultEvents].sort();
	function check(app: z.infer<typeof App>) {
		const external = new URL(app.external_url);
		if (
			app.id !== appId ||
			app.owner.id !== ownerId ||
			app.owner.type !== (options.expectedOwnerType ?? "User") ||
			external.origin !== origin.origin ||
			external.pathname !== "/" ||
			external.search ||
			external.hash ||
			external.username ||
			external.password ||
			JSON.stringify(Object.entries(app.permissions).sort()) !==
				JSON.stringify(expectedPermissions) ||
			JSON.stringify([...app.events].sort()) !== JSON.stringify(expectedEvents)
		)
			throw new Error(
				"GitHub App manifest does not match reviewed configuration",
			);
	}
	if (converted) check(converted);
	const now = Math.floor((options.now ?? Date.now)() / 1000);
	if (!Number.isSafeInteger(now) || now < 60)
		throw new Error("invalid GitHub App verification time");
	const header = Buffer.from(
		JSON.stringify({ alg: "RS256", typ: "JWT" }),
	).toString("base64url");
	const payload = Buffer.from(
		JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }),
	).toString("base64url");
	const input = `${header}.${payload}`;
	const signature = createSign("RSA-SHA256")
		.update(input)
		.sign(options.pem)
		.toString("base64url");
	const authorization = `Bearer ${input}.${signature}`;
	const send = options.fetch ?? fetch;
	const request = async (path: string) => {
		const result = await send(`https://api.github.com${path}`, {
			headers: {
				authorization,
				accept: "application/vnd.github+json",
				"x-github-api-version": "2026-03-10",
			},
			redirect: "error",
			signal: AbortSignal.timeout(15_000),
		});
		if (!result.ok) throw new Error("GitHub App verification failed");
		return result.json();
	};
	const live = App.parse(await request("/app"));
	check(live);
	if (converted && live.slug !== converted.slug)
		throw new Error("GitHub App identity changed during verification");
	const hook = Hook.parse(await request("/app/hook/config"));
	if (hook.url !== `${origin.origin}/github/webhooks`)
		throw new Error(
			"GitHub App webhook URL does not match reviewed configuration",
		);
}
