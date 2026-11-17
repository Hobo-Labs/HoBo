import {spawnSync} from 'node:child_process';
import path from 'node:path';
const cue=process.env.HOBO_CUE_BIN ?? 'cue';
const root=path.resolve('packages/dispatcher/data-models');
const schema=path.join(root,'dispatch.cue');
const validate=(fixture:string,definition='#CreditLedgerViewRecord')=>spawnSync(cue,['vet','-c',schema,path.join(root,'fixtures',fixture),'-d',definition],{encoding:'utf8'});
const valid=validate('valid/credit-ledger-max-sequence.json');
if (valid.error) throw new Error(`CUE is required; set HOBO_CUE_BIN or put cue on PATH: ${valid.error.message}`);
if (valid.status !== 0) throw new Error(`safe sequence rejected: ${valid.stderr}`);
const invalid=validate('invalid/credit-ledger-unsafe-sequence.json');
if (invalid.error || invalid.status === 0 || !invalid.stderr.includes('out of bound'))
  throw new Error(`unsafe sequence was not rejected by the CUE bound: ${invalid.stderr}`);
console.log('PASS: CUE accepts the maximum safe sequence and rejects the next integer');
const reservation=validate('valid/reservation.json','#ReservationRecord');
if (reservation.error || reservation.status !== 0) throw new Error(`valid reservation rejected: ${reservation.stderr}`);
for (const [fixture,field] of [
  ['reservation-overconsumption.json','free_headroom'],
  ['reservation-overrate.json','rate_units'],
  ['reservation-overslots.json','concurrency_slots'],
]) {
  const result=validate(`invalid/${fixture}`,'#ReservationRecord');
  if (result.error || result.status === 0 || !result.stderr.includes(field) || !result.stderr.includes('out of bound'))
    throw new Error(`invalid ${field} was not rejected by the CUE bound: ${result.stderr}`);
}
console.log('PASS: CUE rejects over-restorable free, rate, and slot quantities');
