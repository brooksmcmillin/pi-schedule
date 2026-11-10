import { AuthorityClient } from "../../src/authority-protocol.js";
const [home, jobId, nextRunAt] = process.argv.slice(2);
const client = new AuthorityClient(home!, "benchmark-client");
const result = await client.request({ op: "run_now", jobId: jobId!, cwd: "/workspace", nextRunAt: nextRunAt! });
await client.request({ op: "scan" });
console.log(JSON.stringify(result));
