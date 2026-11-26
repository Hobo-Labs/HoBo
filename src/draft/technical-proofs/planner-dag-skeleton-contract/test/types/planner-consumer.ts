import type { DeploymentPlan } from "../../../deployment-plan-ir-contract/src/deployment-plan-ir.d.js";
import {
  createFixtureManifestIr,
  plan,
  type PlannerInput,
  type PlannerResult,
} from "@hobo/draft-planner-dag-skeleton-contract";

const input: PlannerInput = {
  manifest: createFixtureManifestIr(),
  config: {
    deploymentId: "deploy-gallery-preview",
    context: {
      envType: "ephemeral",
      app: "gallery",
      env: "preview",
      tenant: "tenant-acme"
    }
  }
};

const result: PlannerResult = plan(input.manifest, input.config);
const deploymentPlan: DeploymentPlan = result.deploymentPlan;

deploymentPlan.resources.map((resource) => resource.id);
result.plannedEvent.data.planHash.toString();
