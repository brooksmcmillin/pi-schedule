import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { AuthorityStore, authorityPaths } from "./authority-store.js";
import {
  AUTHORITY_PROTOCOL_VERSION, AUTHORITY_SCHEMA_VERSION, AuthorityError,
  authorityJobSchema, fenceSchema,
} from "./authority-types.js";

export const MAX_AUTHORITY_FRAME_BYTES = 1024 * 1024;
const IO_TIMEOUT_MS = 5000;
const text = Type.String({ minLength: 1 });
const ownerSchema = Type.Object({ sessionId: text, cwd: text, generation: text }, { additionalProperties: false });
export const jobDefinitionSchema = Type.Omit(authorityJobSchema, [
  "id", "enabled", "cancelled", "manualRequested", "terminated", "createdAt", "updatedAt",
  "lastRunAt", "nextRunAt", "runCount", "lastStatus", "lastError", "lastIdempotencyKey", "lastShell",
]);
const requestSchema = Type.Union([
  Type.Object({ op: Type.Literal("create_job"), definition: jobDefinitionSchema }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("register_owner"), sessionId: text, cwd: text }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("receive"), owner: ownerSchema, idle: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("unregister_owner"), owner: ownerSchema }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("begin_delivery"), owner: ownerSchema, fence: fenceSchema }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("defer_delivery"), owner: ownerSchema, fence: fenceSchema }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("finish_delivery"), owner: ownerSchema, fence: fenceSchema, outcome: Type.Union([Type.Literal("completed"), Type.Literal("failed")]), detail: Type.String(), lastShell: Type.Optional(authorityJobSchema.properties.lastShell) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("edit_job"), jobId: text, cwd: text, action: Type.Union([Type.Literal("cancel"), Type.Literal("enable"), Type.Literal("disable")]) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("run_now"), jobId: text, cwd: text, nextRunAt: text, requesterSessionId: Type.Optional(text) }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("scan") }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("snapshot") }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("add_job"), job: authorityJobSchema }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("claim"), jobId: text, slotId: text, ownerId: text, at: text }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("start"), fence: fenceSchema, at: text }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("interrupt"), fence: fenceSchema, detail: text, at: text }, { additionalProperties: false }),
  Type.Object({ op: Type.Literal("acknowledge"), fence: fenceSchema, outcome: Type.Union([Type.Literal("completed"), Type.Literal("failed")]), nextRunAt: text, at: text }, { additionalProperties: false }),
]);
export type AuthorityRequest = Static<typeof requestSchema>;

const envelopeSchema = Type.Object({
  requestId: text, protocolVersion: Type.Literal(AUTHORITY_PROTOCOL_VERSION),
  schemaVersion: Type.Literal(AUTHORITY_SCHEMA_VERSION), buildId: text, request: requestSchema,
}, { additionalProperties: false });
const responseSchema = Type.Union([
  Type.Object({ requestId: text, protocolVersion: Type.Literal(AUTHORITY_PROTOCOL_VERSION), schemaVersion: Type.Literal(AUTHORITY_SCHEMA_VERSION), ok: Type.Literal(true), result: Type.Unknown() }, { additionalProperties: false }),
  Type.Object({ requestId: Type.String(), protocolVersion: Type.Literal(AUTHORITY_PROTOCOL_VERSION), schemaVersion: Type.Literal(AUTHORITY_SCHEMA_VERSION), ok: Type.Literal(false), error: Type.Object({ code: text, message: text }, { additionalProperties: false }) }, { additionalProperties: false }),
]);

function dispatch(store: AuthorityStore, request: AuthorityRequest, buildId: string): unknown {
  switch (request.op) {
    case "snapshot": return store.snapshot();
    case "add_job": return store.addJob(request.job);
    case "claim": return store.claim(request.jobId, request.slotId, request.ownerId, buildId, request.at);
    case "start": return store.start(request.fence, request.at);
    case "interrupt": return store.interrupt(request.fence, request.detail, request.at);
    case "acknowledge": return store.acknowledge(request.fence, request.outcome, request.nextRunAt, request.at);
  }
}

/** One newline-delimited JSON request/response per private Unix connection. No TCP listener. */
export async function listenAuthority(store: AuthorityStore, home: string,
  handler?: (request: AuthorityRequest, buildId: string) => unknown | Promise<unknown>) {
  const paths = authorityPaths(home);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  chmodSync(paths.directory, 0o700);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(IO_TIMEOUT_MS, () => socket.destroy());
    socket.setEncoding("utf8");
    let buffer = "";
    let bytes = 0;
    let handled = false;
    const respond = (requestId: string, body: object) => {
      const response = JSON.stringify({ requestId, protocolVersion: AUTHORITY_PROTOCOL_VERSION, schemaVersion: AUTHORITY_SCHEMA_VERSION, ...body }) + "\n";
      if (Buffer.byteLength(response) > MAX_AUTHORITY_FRAME_BYTES) {
        socket.end(JSON.stringify({ requestId, protocolVersion: AUTHORITY_PROTOCOL_VERSION, schemaVersion: AUTHORITY_SCHEMA_VERSION, ok: false,
          error: { code: "FRAME_TOO_LARGE", message: "Response exceeds protocol limit; inspect authority locally" } }) + "\n");
      } else socket.end(response);
    };
    socket.on("data", async (chunk: string) => {
      if (handled) return;
      bytes += Buffer.byteLength(chunk);
      buffer += chunk;
      if (bytes > MAX_AUTHORITY_FRAME_BYTES) {
        handled = true;
        respond("", { ok: false, error: { code: "FRAME_TOO_LARGE", message: "Authority request exceeds 1 MiB" } });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      let requestId = "";
      try {
        if (buffer.slice(newline + 1).trim()) throw new AuthorityError("INVALID_REQUEST", "Send one request per connection");
        const envelope = JSON.parse(buffer.slice(0, newline));
        if (envelope && typeof envelope.requestId === "string") requestId = envelope.requestId;
        if (envelope?.protocolVersion !== AUTHORITY_PROTOCOL_VERSION || envelope?.schemaVersion !== AUTHORITY_SCHEMA_VERSION) {
          throw new AuthorityError("VERSION_MISMATCH", `Authority requires protocol ${AUTHORITY_PROTOCOL_VERSION}, schema ${AUTHORITY_SCHEMA_VERSION}. Upgrade/reload pi-schedule clients and dispatcher together; state was not changed.`);
        }
        if (!Value.Check(envelopeSchema, envelope)) throw new AuthorityError("INVALID_REQUEST", "Invalid authority request or job; supply explicit target, absolute workspace and session owner");
        const result = handler
          ? await handler(envelope.request, envelope.buildId)
          : dispatch(store, envelope.request, envelope.buildId);
        respond(requestId, { ok: true, result });
      } catch (error) {
        respond(requestId, { ok: false, error: {
          code: error instanceof AuthorityError ? error.code : "AUTHORITY_ERROR",
          message: error instanceof Error ? error.message : "Authority request failed",
        } });
      }
    });
  });
  // Never unlink an existing socket: it may belong to a live dispatcher.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => {
      server.removeListener("error", reject);
      try { chmodSync(paths.socket, 0o600); resolve(); }
      catch (error) { server.close(); reject(error); }
    });
  });
  return {
    socketPath: paths.socket,
    close: () => new Promise<void>((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

export class AuthorityClient {
  constructor(private readonly home: string, private readonly buildId: string) {}

  request(request: AuthorityRequest): Promise<unknown> {
    const requestId = randomUUID();
    const frame = JSON.stringify({ requestId, protocolVersion: AUTHORITY_PROTOCOL_VERSION,
      schemaVersion: AUTHORITY_SCHEMA_VERSION, buildId: this.buildId, request }) + "\n";
    if (Buffer.byteLength(frame) > MAX_AUTHORITY_FRAME_BYTES) return Promise.reject(new AuthorityError("FRAME_TOO_LARGE", "Authority request exceeds 1 MiB"));
    return new Promise((resolve, reject) => {
      const socket = createConnection(authorityPaths(this.home).socket);
      let settled = false;
      let buffer = "";
      let bytes = 0;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error); else resolve(result);
      };
      const unavailable = () => finish(new AuthorityError("AUTHORITY_UNAVAILABLE", "Scheduler authority unavailable or request outcome unknown. Start/check the dispatcher, reload pi-schedule, and inspect current state before retrying mutations. No legacy fallback."));
      socket.setTimeout(IO_TIMEOUT_MS, unavailable);
      socket.on("error", unavailable);
      socket.on("end", () => { if (!settled) unavailable(); });
      socket.on("connect", () => socket.end(frame));
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        buffer += chunk;
        if (bytes > MAX_AUTHORITY_FRAME_BYTES) return finish(new AuthorityError("FRAME_TOO_LARGE", "Authority response exceeds 1 MiB"));
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline));
          if (buffer.slice(newline + 1).trim() || !Value.Check(responseSchema, response) || response.requestId !== requestId) throw new AuthorityError("INVALID_RESPONSE", "Incompatible or unbound authority response; reload clients and dispatcher");
          if (!response.ok) finish(new AuthorityError(response.error.code, response.error.message));
          else finish(undefined, response.result);
        } catch (error) {
          finish(error instanceof AuthorityError ? error : new AuthorityError("INVALID_RESPONSE", "Malformed authority response; inspect dispatcher before retry"));
        }
      });
    });
  }
}
