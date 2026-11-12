// A relay-shaped Bindle whose Yard places it on a provider `hobo ci deploy`
// does not realize (test/ci-relay-deploy.test.ts).
import { bindle } from "@hobo/bindles";

export default bindle("relay-fixture", (b) => ({ relay: b.api() }));
