# HoBo CI parity gauntlet

The gauntlet turns each thing RelayRunner says it does into one case with a
pass condition, and checks each case at the strongest tier that fits it. The
decision record is ADR-0183 ([runner order](../../docs/ci/runner-order.md));
the result is the generated [parity scorecard](../../docs/ci/parity-scorecard.md).

| Tier | What runs | Proves |
| --- | --- | --- |
| T1 | The pure rules, called directly | The rule is right |
| T2 | The relay code against the GitHub simulator | The parts work together with no network |
| T3 | A scheduled workflow in this repository that routes a real job | The channel carried a value in production |

## Files

| File | Holds |
| --- | --- |
| [`cases.json`](cases.json) | The catalog: every case's id, area, RelayRunner's claim and the file it was read from (at the commit named there), HoBo's bar, tiers, owning work packages, the state it had before its scenario ran, and, once one exists, the production run that proves its T3 part (`t3Run`) |
| `*.feature` | One scenario per case, one file per area |
| [`steps/driver.ts`](steps/driver.ts) | `ParityDriver`, the one interface routing steps drive a relay through, and `FakeParityDriver` over the in-memory ports of `@hobo/ci/runner-order/testing` and the real `answerRelayJob` |
| [`steps/parity.steps.ts`](steps/parity.steps.ts) | The step definitions |
| [`cucumber.yaml`](cucumber.yaml) | The suite on its own, without the `@pending` and `@met-differently` scenarios |

## Tags

A scenario carries `@parity`, its case id and one tag per tier in the
catalog (`@t1`, `@t2`, `@t3`). Two more tags say why it does not run:

- `@pending`: the work package that builds the case has not landed. Its steps
  are written by that package, which removes the tag.
- `@met-differently`: HoBo meets the need another way; the catalog says why.

## States

The scorecard script reads the tags and the run's results. An executed
scenario needs at least one step, and every step and hook must
pass; setup hooks alone do not establish a passing case.
When the script runs Cucumber itself, a failed Cucumber process also makes the
command fail even if its report contains passing steps.

| Scenario | State |
| --- | --- |
| Pending, or not run | The catalog's `today` state |
| Failed | `partial` |
| Passed, and the case has no T3 part or its `t3Run` is linked | `pass` |
| Passed, T3 owed | `built-not-proven` |
| Tagged `@met-differently` | `met-differently` |

## Running it

```bash
node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js --config features/hobo-ci-parity/cucumber.yaml
node --import tsx scripts/ci/parity-scorecard.mts           # run the suite and write the scorecard
node --import tsx scripts/ci/parity-scorecard.mts --check   # fail when the scorecard is stale or a case has no scenario
```

No scenario touches a real provider, a paid service or GitHub.

## Moving a case to the simulator

When the GitHub simulator lands, a driver over it implements `ParityDriver`
and the routing scenarios run against it unchanged. A package that builds a
case writes its steps, removes `@pending` from its scenario and regenerates
the scorecard in the same commit.
