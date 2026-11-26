import { runFoundationsBuildConformanceSimulation } from "../services/foundations-reference-architecture.js";

const result = await runFoundationsBuildConformanceSimulation();

console.log(
  JSON.stringify(
    {
      epic: result.epic,
      slices: result.verticalSlices.map((slice) => slice.id),
      contracts: result.contracts.covered,
      outcomes: {
        workspace: result.workspace.status,
        componentSmoke: result.componentize.smoke.exitCode,
        ciE2e: result.ci.e2e.status,
        artifactInstall: result.artifactTrust.install.assurance,
      },
      negativeCases: {
        adapterImport: result.negative.adapterImport.effect,
        coreSurface: result.negative.providerSpecificCoreSurface.ok,
        ciMissingOidc: result.negative.ciMissingOidc.passed,
        unsignedArtifact: result.negative.unsignedArtifact.ok,
      },
    },
    null,
    2,
  ),
);
