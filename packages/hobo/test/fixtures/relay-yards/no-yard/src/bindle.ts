// A relay-shaped Bindle with no Yard beside it: `hobo ci deploy` has nowhere
// to place it (test/ci-relay-deploy.test.ts).
import { bindle } from "@hobo/bindles";

export default bindle("relay-fixture", (b) => ({ relay: b.api() }));
