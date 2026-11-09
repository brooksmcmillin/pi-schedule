import { AuthorityStore } from "../../src/authority-store.js";
import { AuthorityError } from "../../src/authority-types.js";

const [home, operation, owner] = process.argv.slice(2);
if (!home) throw new Error("Fixture requires temporary home");
const store = new AuthorityStore(home);
try {
  const result = operation === "claim"
    ? store.claim("job-test", "slot-test", owner!, "fixture", "2026-11-09T00:00:00Z")
    : store.snapshot();
  console.log(JSON.stringify(result));
} catch (error) {
  if (!(error instanceof AuthorityError)) throw error;
  console.log(JSON.stringify({ code: error.code }));
} finally {
  store.close();
}
