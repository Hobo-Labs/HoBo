import { readFileSync, existsSync } from "node:fs";
import { SecretValue } from "../core/secret-value.js";
import type { SecretsPort, SecretAccessContext } from "../core/ports/secrets.js";
import { SecretUnavailableError } from "../core/ports/secrets.js";

export type DevSecretsAdapterOptions = {
  readonly envLocalPath?: string;
  readonly keychain?: KeychainReader;
  readonly prompt?: PromptReader;
  readonly isCi?: boolean;
};

export type KeychainReader = (service: string, account: string) => string | undefined;
export type PromptReader = (message: string) => Promise<string> | string;

export type DevSecretsAdapter = SecretsPort & {
  readonly reads: ReadonlyArray<{ readonly ref: string; readonly source: "env-local" | "keychain" | "prompt" }>;
  readonly productionDeployable: false;
};

export function createDevSecretsAdapter(options: DevSecretsAdapterOptions = {}): DevSecretsAdapter {
  const envLocalPath = options.envLocalPath ?? ".env.local";
  const keychain = options.keychain ?? defaultKeychainReader();
  const prompt = options.prompt;
  const isCi = options.isCi ?? Boolean(process.env.CI);
  const reads: Array<{ ref: string; source: "env-local" | "keychain" | "prompt" }> = [];

  return {
    productionDeployable: false as const,
    get reads() {
      return reads;
    },
    async get(ref: string, ctx: SecretAccessContext): Promise<SecretValue> {
      const envValue = readEnvLocal(envLocalPath, ref);
      if (envValue !== undefined) {
        reads.push({ ref, source: "env-local" });
        return new SecretValue(envValue);
      }

      const keychainValue = keychain("hobo", ref);
      if (keychainValue !== undefined) {
        reads.push({ ref, source: "keychain" });
        return new SecretValue(keychainValue);
      }

      if (isCi) {
        throw new SecretUnavailableError(ref, ctx.camp, "secret not found in dev ladder");
      }

      if (!prompt) {
        throw new SecretUnavailableError(ref, ctx.camp, "interactive prompt unavailable");
      }

      const prompted = await prompt(`Enter secret for ${ref}: `);
      if (!prompted || prompted.trim() === "") {
        throw new SecretUnavailableError(ref, ctx.camp, "prompt returned empty value");
      }

      reads.push({ ref, source: "prompt" });
      return new SecretValue(prompted);
    },
  };
}

function readEnvLocal(path: string, ref: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const content = readFileSync(path, "utf8");
  const envKey = refToEnvKey(ref);
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === envKey || key === ref) {
      return trimmed.slice(eq + 1).trim();
    }
  }
  return undefined;
}

function refToEnvKey(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
}

function defaultKeychainReader(): KeychainReader {
  return () => undefined;
}

export interface EnvLocalBag {
  [key: string]: string;
}

export function parseEnvLocal(content: string): EnvLocalBag {
  const entries: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    entries[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return entries;
}
