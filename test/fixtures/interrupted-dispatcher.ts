import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Dispatcher, type Delivery, type OwnerConnection } from "../../src/dispatcher.js";

const [home, phase] = process.argv.slice(2);
if (!home) throw new Error("Temporary fixture home required");
const dispatcher = new Dispatcher({ home, now: () => new Date("2026-11-09T00:00:00Z") });
await dispatcher.start();
const owner = dispatcher.request({ op: "register_owner", sessionId: "owner", cwd: home }) as OwnerConnection;
let delivery: Delivery | undefined;
if (phase !== "before_claim") {
  delivery = dispatcher.request({ op: "receive", owner, idle: true }) as Delivery;
  if (phase !== "claimed") dispatcher.request({ op: "begin_delivery", owner, fence: delivery.fence });
  if (phase === "effect") writeFileSync(join(home, "external-effect"), delivery.fence.runId);
}
console.log(JSON.stringify({ owner, delivery }));
setInterval(() => {}, 1000);
