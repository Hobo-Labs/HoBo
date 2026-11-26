#!/usr/bin/env node
import { runForgeIngestion } from "./forge-ingestion.js";

export async function runForgeCli(argv: string[]): Promise<number> {
  const fixtureUrl = argv[2];

  if (!fixtureUrl || fixtureUrl === "--help" || fixtureUrl === "-h") {
    process.stdout.write(
      [
        "Usage: hobo forge <fixture-url>",
        "",
        "Fixture URL schemes:",
        "  fixture://<slug>   — recorded fixture under fixtures/<slug>/",
        "  file://<path>      — local fixture directory or index.json path",
        "",
        "Example:",
        "  hobo forge fixture://mock-postgres-backend"
      ].join("\n") + "\n"
    );
    return fixtureUrl ? 0 : 1;
  }

  const result = await runForgeIngestion(fixtureUrl);

  if (result.status === "material-refused") {
    process.stderr.write(
      `forge ingestion refused for ${result.requestId}: ${result.reason}\n`
    );
    process.stderr.write(`events: ${result.eventTypes.join(" -> ")}\n`);
    return 2;
  }

  process.stdout.write(
    JSON.stringify(
      {
        status: result.status,
        requestId: result.requestId,
        providerId: result.providerId,
        packageDir: result.packageDir,
        packageRef: result.packageRef,
        eventTypes: result.eventTypes
      },
      null,
      2
    ) + "\n"
  );

  return 0;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  runForgeCli(process.argv)
    .then((code) => {
      if (code !== 0) {
        process.exitCode = code;
      }
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
