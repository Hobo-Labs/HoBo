import { describeNightlyPlan } from "./nightly.js";

const plan = describeNightlyPlan();
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
if (plan.liveClouds !== "forbidden") {
	process.exit(2);
}
