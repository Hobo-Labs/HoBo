# contracts

One PACT, `pacts/selection-candidate-codec.pact.json`, and it is verified by
**replay** rather than by being read.

The boundary it names is the one the decomposition actually cut.
`SelectionCandidate` and its wire codec moved into `@hobo/manifest-request`;
every gate that reads a candidate — conformance, evidence freshness, trust
policy, binding-profile consumability, and the lexicographic tiebreak — stayed
in `@hobo/capability-profiles`. So the contract between them is not "the record
has these keys". A structural comparison passes that while a widened vocabulary,
a normalised absent field, or a number decoded as a string silently changes a
decision.

The contract is: **a candidate that has been through the codec produces the same
verdict.** `test/pact.test.ts` decodes each interaction's records with
`fromSelectionCandidateRecord`, runs them through
`selectCapabilityImplementation`, and asserts the winner and the ordered
rejection codes equal the recorded response. Four interactions: a clean win, a
conformance failure, a profile incompatibility, and expired evidence — one per
gate that can change a verdict for a reason the record carries.

`test/round-trip.test.ts` runs the same property over all 35 candidates the
selection suite itself exercises. The pact is the small, readable, committed
statement of it; the round trip is the wide sweep.
