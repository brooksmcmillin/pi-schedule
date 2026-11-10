import { runWatchdog } from "../../src/watchdog-command.js";
const [home, at, endpoint] = process.argv.slice(2);
if (!home || !at || !endpoint) throw new Error("Expected fixture home/clock/mock endpoint");
const result = await runWatchdog({ home, now: () => new Date(at), notify: async (event) => {
  const response = await fetch(endpoint, { method: "POST", body: JSON.stringify(event) });
  if (!response.ok) throw new Error("mock notification failed");
  return { messageId: "mock-receipt" };
} });
console.log(JSON.stringify(result));
