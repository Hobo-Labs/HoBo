import {
  runMultiCloudShopCanaryRegression,
  runReferenceAppGreen,
} from "../services/deployment-strategy-orchestrator.js";

const mode = process.argv[2] ?? "all";

async function main() {
  if (mode === "green" || mode === "all") {
    const green = await runReferenceAppGreen();
    console.log(JSON.stringify({ mode: "reference-app-green", ...green }, null, 2));
    if (!green.allPromoted) {
      process.exitCode = 1;
    }
  }

  if (mode === "canary-regression" || mode === "all") {
    const regression = await runMultiCloudShopCanaryRegression();
    console.log(JSON.stringify({ mode: "canary-regression", ...regression }, null, 2));
    if (!regression.rolledBack) {
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
