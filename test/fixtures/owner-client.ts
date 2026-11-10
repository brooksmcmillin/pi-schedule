import { AuthorityClient, type AuthorityRequest } from "../../src/authority-protocol.js";
const [home, encoded] = process.argv.slice(2);
const client = new AuthorityClient(home!, "owner-benchmark");
try { console.log(JSON.stringify({ result: await client.request(JSON.parse(encoded!) as AuthorityRequest) })); }
catch (error) { console.log(JSON.stringify({ error: String(error) })); }
