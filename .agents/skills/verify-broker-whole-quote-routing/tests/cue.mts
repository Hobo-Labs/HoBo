import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const scratch=mkdtempSync(path.join(os.tmpdir(),'hobo-whole-quote-cue-'));
const cue=process.env.HOBO_CUE_BIN ?? 'cue';
try {
  copyFileSync(path.resolve('packages/broker/data-models/broker.cue'),path.join(scratch,'broker.cue'));
  for (const [label,second,expected] of [['distinct','b',0],['duplicate','a',1]] as const) {
    writeFileSync(path.join(scratch,'fixture.cue'),`package data_models\nrequest: #BrokerRequest & {\n schema_version: "hobo.broker/v1"\n request_id: "req"\n scope: {bindle_id: "b"}\n requirements: [{resource_id: "a", port: "p"}, {resource_id: "${second}", port: "p"}]\n spend_estimate_usd: 0\n}\n`);
    const result=spawnSync(cue,['vet','broker.cue','fixture.cue','-c'],{cwd:scratch,encoding:'utf8'});
    if (result.error) throw result.error;
    if ((result.status === 0) !== (expected === 0) || (expected !== 0 && !result.stderr.includes('_unique_resource_ids'))) {
      throw new Error(`unexpected ${label} CUE result: ${result.status}\n${result.stdout}\n${result.stderr}`);
    }
    process.stdout.write(`CUE ${label} resource identities: ${expected === 0 ? 'accepted' : 'refused'}\n`);
  }
} finally { rmSync(scratch,{recursive:true,force:true}); }
