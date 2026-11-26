import {
  assertGeneratedMatches,
  validateToolchainLock,
  writeGeneratedBindings,
} from "../src/wit-toolchain-contract.js";

await validateToolchainLock();

if (process.argv.includes("--check")) {
  const result = await assertGeneratedMatches();
  console.log(`wit:check ok (${result.checked} generated declaration files)`);
} else {
  const files = await writeGeneratedBindings();
  console.log(`wit:gen wrote ${files.length} declaration files`);
}
