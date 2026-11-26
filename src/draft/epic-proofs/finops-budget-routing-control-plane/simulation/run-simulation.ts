import {
  runFinopsRoutingControlPlaneSimulation,
} from "../services/finops-routing-control-plane.js";

const result = await runFinopsRoutingControlPlaneSimulation();

console.log(JSON.stringify({
  epic: result.epic,
  status: result.approvedRoute.status,
  selectedCandidate: result.approvedRoute.routingDecision.selectedCandidateId,
  decisionGraph: result.approvedRoute.decisionGraph.id,
  contractsCovered: result.contracts.covered,
  mockedAdapterFixtures: result.adapterFixtures.map((fixture) => fixture.adapter),
}, null, 2));
