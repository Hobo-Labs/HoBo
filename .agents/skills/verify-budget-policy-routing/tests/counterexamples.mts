import {strict as assert} from 'node:assert';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.BUDGET_ROUTER_VERIFY_PACKAGE_ROOT ?? path.resolve('packages/dispatcher');
const {createDispatcherRegistry,createReservationLedger,decideDispatch}=await import(pathToFileURL(path.join(root,'src/dispatcher.ts')).href);
function check(price:number,cap:number,spent:number) {
  const registry=createDispatcherRegistry([{providerId:'p',category:'runner',listUnitCost:price}]);
  const ledgerView={view:'CreditLedgerView',seq:0,accounts:[{providerId:'p',dimension:'runner.minutes',currency:'USD',listUnitCost:price,freeHeadroom:0,budgetCap:cap,spendToDate:spent}]};
  const decision=decideDispatch({registry,category:'runner',dispatchId:'repro',units:1,ledgerView});
  const ledger=createReservationLedger(ledgerView);
  const reservation=ledger.reserve({providerId:'p',dimension:'runner.minutes',reservationId:'repro',units:1,expectedSeq:0});
  return {decision:decision.ok,reservation:reservation.ok,reservedCost:ledger.snapshot().accounts[0].reservedCost ?? 0};
}
const cases=[
  {name:'exactly affordable 20 cents',actual:check(0.2,0.3,0.1),expected:{decision:true,reservation:true,reservedCost:0.2}},
  {name:'positive sub-precision cost at zero cap',actual:check(1e-13,0,0),expected:{decision:false,reservation:false,reservedCost:0}},
];
for (const {name,actual,expected} of cases) {
  try { assert.deepEqual(actual,expected); console.log(`PASS: ${name}`); }
  catch { console.error(`FAIL: ${name}; actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`); process.exitCode=1; }
}
