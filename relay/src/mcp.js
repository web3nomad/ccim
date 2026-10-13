// Remote MCP endpoint (Streamable HTTP, stateless, JSON responses only).
// Stage 0 is a probe: one read-only tool that touches no channel data and needs no auth.
// It exists only to confirm that ChatGPT can add this server and that a Dot can call a tool on it.
// The real tools (ccim_send/inbox/ack/who) arrive with OAuth in the next stage.

const SUPPORTED_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "ccim", version: "0.5.0-probe" };
const PROBE_MARK = "ccim-probe-ok";

const TOOLS = [
  {
    name: "ccim_probe",
    title: "CCIM connectivity probe",
    description: "Returns a fixed marker, a one-time nonce and the server time. Reads no messages and needs no account. Use it only to check that this connector works.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    securitySchemes: [{ type: "noauth" }],
  },
];

export async function handleMcp(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  // Stateless server: no server-initiated stream, no sessions to delete.
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST, OPTIONS", ...CORS } });

  let body;
  try { body = await req.json(); } catch { return rpc(400, error(null, -32700, "parse error")); }
  if (Array.isArray(body)) return rpc(400, error(null, -32600, "batches are not supported"));
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") return rpc(400, error(body?.id ?? null, -32600, "invalid request"));

  // Notifications (no id) get no response body.
  if (body.id === undefined || body.id === null) return new Response(null, { status: 202, headers: CORS });
  return rpc(200, await dispatch(body));
}

async function dispatch({ id, method, params }) {
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return result(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: TOOLS });
    case "tools/call": {
      if (params?.name !== "ccim_probe") return error(id, -32602, `unknown tool: ${params?.name}`);
      // A fresh nonce per call, also written to the Worker log, so a reported result can be matched
      // against `wrangler tail` and cannot have been made up by the model.
      const nonce = crypto.randomUUID();
      console.log(JSON.stringify({ event: "ccim_probe", nonce }));
      const text = `${PROBE_MARK} nonce=${nonce} at ${new Date().toISOString()}`;
      return result(id, { content: [{ type: "text", text }], structuredContent: { ok: true, mark: PROBE_MARK, nonce, serverTime: Date.now() } });
    }
    default:
      return error(id, -32601, `method not found: ${method}`);
  }
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization, mcp-protocol-version, mcp-session-id", "access-control-allow-methods": "POST, OPTIONS" };
const result = (id, result) => ({ jsonrpc: "2.0", id, result });
const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpc = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
