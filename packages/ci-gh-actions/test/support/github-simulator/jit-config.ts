/**
 * The `encoded_jit_config` the simulator's `generate-jitconfig` answers with,
 * in the form the open-source runner reads (`actions/runner`, MIT, read
 * 2026-11-17): base64 of a JSON object whose keys are file names and whose
 * values are each file's bytes in base64 (`src/Runner.Listener/Runner.cs`).
 * The files are `.runner` (`RunnerSettings`,
 * `src/Runner.Common/ConfigurationStore.cs`), `.credentials` (a scheme and
 * its data) and `.credentials_rsaparams` (the RSA key). The runner's JSON
 * settings write property names in camel case.
 *
 * The RSA parameters here are placeholders: the simulator signs nothing.
 */
import { z } from "zod";
import type {
	JitCredentials,
	JitRunnerSettings,
} from "../../../src/runner-protocol/port.js";

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const unbase64 = (text: string) => Buffer.from(text, "base64").toString("utf8");

export type SimulatedJitInput = Readonly<{
	agentId: number;
	agentName: string;
	/** The repository or organization URL the runner was registered on. */
	gitHubUrl: string;
	/** The simulator's runner service URL, ending in `/`. */
	serverUrl: string;
	workFolder: string;
}>;

/** Encode a one-job runner's configuration as GitHub hands it out. */
export function encodeSimulatedJitConfig(input: SimulatedJitInput): string {
	const runner = {
		agentId: input.agentId,
		agentName: input.agentName,
		poolId: 1,
		poolName: "Default",
		ephemeral: true,
		serverUrl: input.serverUrl,
		gitHubUrl: input.gitHubUrl,
		workFolder: input.workFolder,
	};
	const credentials = {
		scheme: "OAuth",
		data: {
			clientId: `00000000-0000-4000-8000-${String(input.agentId).padStart(12, "0")}`,
			authorizationUrl: `${input.serverUrl}oauth2/token`,
			requireFipsCryptography: "False",
		},
	};
	const rsa = {
		d: "",
		dp: "",
		dq: "",
		exponent: "AQAB",
		inverseQ: "",
		modulus: "",
		p: "",
		q: "",
	};
	return base64(
		JSON.stringify({
			".runner": base64(JSON.stringify(runner)),
			".credentials": base64(JSON.stringify(credentials)),
			".credentials_rsaparams": base64(JSON.stringify(rsa)),
		}),
	);
}

const Files = z.object({
	".runner": z.string(),
	".credentials": z.string(),
	".credentials_rsaparams": z.string(),
});
const RunnerFile = z.object({
	agentId: z.number(),
	agentName: z.string(),
	poolId: z.number(),
	serverUrl: z.string(),
	gitHubUrl: z.string(),
	workFolder: z.string(),
	useV2Flow: z.boolean().optional(),
	serverUrlV2: z.string().optional(),
});
const CredentialsFile = z.object({
	scheme: z.string(),
	data: z.object({ clientId: z.string(), authorizationUrl: z.string() }),
});

/** The three files of a one-job runner's configuration, read back. */
export type DecodedJitConfig = Readonly<{
	runner: JitRunnerSettings;
	credentials: JitCredentials;
	rsaParameters: string;
}>;

/** Decode what `encodeSimulatedJitConfig` wrote, for tests of the simulator itself. */
export function decodeSimulatedJitConfig(encoded: string): DecodedJitConfig {
	const files = Files.parse(JSON.parse(unbase64(encoded)));
	const runner = RunnerFile.parse(JSON.parse(unbase64(files[".runner"])));
	const credentials = CredentialsFile.parse(
		JSON.parse(unbase64(files[".credentials"])),
	);
	return {
		runner: {
			agentId: runner.agentId,
			agentName: runner.agentName,
			poolId: runner.poolId,
			serverUrl: runner.serverUrl,
			gitHubUrl: runner.gitHubUrl,
			workFolder: runner.workFolder,
			useV2Flow: runner.useV2Flow ?? false,
			serverUrlV2: runner.serverUrlV2 ?? "",
		},
		credentials: {
			scheme: credentials.scheme,
			clientId: credentials.data.clientId,
			authorizationUrl: credentials.data.authorizationUrl,
		},
		rsaParameters: unbase64(files[".credentials_rsaparams"]),
	};
}
