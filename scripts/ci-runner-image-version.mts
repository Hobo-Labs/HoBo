#!/usr/bin/env node
import { ciRunnerImageVersion } from "./lib/ci-runner-contract.mts";

console.log(ciRunnerImageVersion(process.cwd()));
