/**
 * Step implementations for `cli-product`.
 * Runs the REAL product CLI (`hobo` from @hobo/cli, and the composed `hobo`
 * from @hobo/hobo) and captures exit code / stdout / stderr / parsed JSON
 * envelope so Then-steps assert observable behavior, not vibes.
 *
 * Invocation strategy:
 * - `hobo`: prefers the built bin `packages/cli/dist/bin/hobo.js`; falls
 *   back to `pnpm exec tsx packages/cli/src/bin/hobo.ts`. Both need the
 *   workspace dependencies built once (`pnpm --filter @hobo/cli... build`).
 * - composed `hobo` (real verb handlers incl. doctor): prefers
 *   `packages/hobo/dist/bin/hobo.js`; falls back to tsx on the source entry.
 *
 * Do not call live third-party services from default tests.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { OptimizexpWorld } from "./world.ts";

/** Discovery snapshot — real product CLIs, confidence high. */
export const DISCOVERY_PRIMARY = {
  command: "hobo --help" as string | null,
  confidence: "high",
  reason:
    "seed wants the product CLI exercised directly; the hobo bins run offline",
};

export const IMPLEMENTATION_STATUS = {
  exerciseSurface: "wired",
  criticalPath: "wired",
  failurePath: "wired",
} as const;

const HOBO_DIST_BIN = path.join("packages", "cli", "dist", "bin", "hobo.js");
const HOBO_SRC_BIN = path.join("packages", "cli", "src", "bin", "hobo.ts");
const HOBO_COMPOSED_DIST_BIN = path.join(
  "packages",
  "hobo",
  "dist",
  "bin",
  "hobo.js",
);
const HOBO_COMPOSED_SRC_ENTRY = path.join(
  "packages",
  "hobo",
  "src",
  "bin",
  "hobo.ts",
);

function hoboCommand(args: string): string {
  if (existsSync(path.join(process.cwd(), HOBO_DIST_BIN))) {
    return `node ${HOBO_DIST_BIN} ${args}`;
  }
  return `pnpm exec tsx ${HOBO_SRC_BIN} ${args}`;
}

/**
 * The composed CLI (`@hobo/hobo`) wires the real verb handlers (doctor,
 * messaging, …). Use this for scenarios that assert real product behavior;
 * the bare `@hobo/cli` bin intentionally serves stub envelopes for un-wired
 * verbs.
 */
function hoboComposedCommand(args: string): string {
  if (existsSync(path.join(process.cwd(), HOBO_COMPOSED_DIST_BIN))) {
    return `node ${HOBO_COMPOSED_DIST_BIN} ${args}`;
  }
  return `pnpm exec tsx ${HOBO_COMPOSED_SRC_ENTRY} ${args}`;
}

export function setPersona(world: OptimizexpWorld, personaId: string): void {
  world.personaId = personaId;
  world.notes.push(`persona active: ${personaId}`);
}

export function setFeatureContext(world: OptimizexpWorld, featureId: string): void {
  world.featureId = featureId;
  world.notes.push(`feature under review: ${featureId}`);
}

function runShell(world: OptimizexpWorld, command: string): void {
  world.lastCommand = command;
  const r = spawnSync("bash", ["-lc", command], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env },
  });
  world.lastExitCode = r.status;
  world.lastStdout = r.stdout ?? "";
  world.lastStderr = r.stderr ?? "";
  world.lastJson = null;
  const trimmed = world.lastStdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      world.lastJson = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      world.notes.push("stdout looked like JSON but failed to parse");
    }
  }
  world.notes.push(`ran ${command} → exit ${r.status}`);
  world.statusClear = true;
}

export function runHoboCli(world: OptimizexpWorld, args: string): void {
  runShell(world, hoboCommand(args));
}

export function runHoboComposedCli(world: OptimizexpWorld, args: string): void {
  runShell(world, hoboComposedCommand(args));
}

export function assertExitCode(world: OptimizexpWorld, expected: number): void {
  if (world.lastExitCode !== expected) {
    throw new Error(
      `Expected exit ${expected}, got ${world.lastExitCode}; cmd=${world.lastCommand} stderr=${world.lastStderr.slice(0, 300)}`,
    );
  }
}

export function assertStdoutContains(world: OptimizexpWorld, text: string): void {
  if (!world.lastStdout.includes(text)) {
    throw new Error(
      `Expected stdout to contain ${JSON.stringify(text)}; cmd=${world.lastCommand} stdout=${world.lastStdout.slice(0, 400)}`,
    );
  }
}

export function assertStdoutMatches(world: OptimizexpWorld, pattern: string): void {
  if (!new RegExp(pattern).test(world.lastStdout)) {
    throw new Error(
      `Expected stdout to match /${pattern}/; cmd=${world.lastCommand} stdout=${world.lastStdout.slice(0, 400)}`,
    );
  }
}

function requireJson(world: OptimizexpWorld): Record<string, unknown> {
  if (!world.lastJson) {
    throw new Error(
      `Expected a JSON envelope on stdout; cmd=${world.lastCommand} stdout=${world.lastStdout.slice(0, 300)}`,
    );
  }
  return world.lastJson;
}

export function assertJsonFieldEquals(
  world: OptimizexpWorld,
  field: string,
  expected: string,
): void {
  const json = requireJson(world);
  const actual = json[field];
  if (String(actual) !== expected && JSON.stringify(actual) !== expected) {
    throw new Error(
      `Expected envelope.${field} == ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}; cmd=${world.lastCommand}`,
    );
  }
}

export function assertJsonFieldNonEmptyArray(
  world: OptimizexpWorld,
  field: string,
): void {
  const json = requireJson(world);
  const actual = json[field];
  if (!Array.isArray(actual) || actual.length === 0) {
    throw new Error(
      `Expected envelope.${field} to be a non-empty array, got ${JSON.stringify(actual)}; cmd=${world.lastCommand}`,
    );
  }
}

export function assertJsonEnvelopeShape(world: OptimizexpWorld): void {
  const json = requireJson(world);
  for (const key of ["ok", "status", "code", "message", "data"]) {
    if (!(key in json)) {
      throw new Error(
        `Expected envelope key ${JSON.stringify(key)}; keys=${Object.keys(json).join(",")}; cmd=${world.lastCommand}`,
      );
    }
  }
}

export function markEvidenceCapturable(world: OptimizexpWorld): void {
  world.evidencePath = `.optimizexp/features/${world.featureId}/evidence/`;
  world.notes.push(`evidence capturable under ${world.evidencePath}`);
}
