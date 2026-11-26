import { runIdentityReferenceSimulation } from "../services/identity-reference-architecture.js";

const result = await runIdentityReferenceSimulation();
console.log(JSON.stringify(result, null, 2));
