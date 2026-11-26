#!/usr/bin/env node
import {
  assertCiFabricContract,
  createHoboCiFabricContract,
} from "../src/ci-fabric-contract.js";

const report = assertCiFabricContract(createHoboCiFabricContract());
console.log(JSON.stringify({ ok: true, coverage: report.coverage }, null, 2));
