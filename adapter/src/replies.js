// Separate durable records avoid losing a send result when polling or ack updates message metadata.
// No message text, headers or credentials are stored here.
import { sha256 } from "./util.js";

const attemptKey = (id, part) => `reply:${id}:p${part}`;
const keysFor = (id) => [1, 2, 3].map((part) => attemptKey(id, part));

export async function replyAttempts(storage, id) {
  const records = await storage.get(keysFor(id));
  return [...records.values()];
}

export function publicAttempt(record) {
  const { fingerprint, ...safe } = record;
  return safe;
}

export async function sendReply(ctx, meta, { part, text, hop, clientId }) {
  const fingerprint = await sha256(JSON.stringify([meta.from, text, false]));
  const attempt = {
    reply_to_id: meta.id, part, clientId, to: meta.from, hop, fingerprint,
    outcome: "uncertain", reason: "in_flight", started_at: ctx.now(),
  };
  let reserved;
  try {
    reserved = await reserve(ctx.storage, meta, attempt);
  } catch {
    return { ...attempt, outcome: "rejected", reason: "storage_unavailable_before_send" };
  }
  if (!reserved.send) return reserved.record;

  let result;
  try {
    result = await ctx.relay.send({ to: meta.from, text, clientId });
  } catch {
    // A transport/parser exception after POST cannot prove that the relay rejected the message.
    result = { outcome: "uncertain", error: "send_exception" };
  }
  const record = {
    ...attempt, outcome: result.outcome || "uncertain", finished_at: ctx.now(),
    reason: result.ok ? "relay_receipt" : result.error,
    ...(result.status !== undefined && { http_status: result.status }),
    ...(result.diagnostic && { diagnostic: result.diagnostic }),
    ...(result.ok && { relay_id: result.id, delivery: result.delivery, duplicate: result.duplicate }),
  };
  try {
    await ctx.storage.put(attemptKey(meta.id, part), record);
  } catch {
    // The pre-send reservation remains durable and blocks a resend even if saving the receipt fails.
    record.persistence = "receipt_not_saved";
  }
  ctx.log("reply_result", publicAttempt(record));
  return record;
}

async function reserve(storage, meta, attempt) {
  return storage.transaction(async (tx) => {
    const all = await replyAttempts(tx, meta.id);
    const previous = all.find((r) => r.part === attempt.part);
    if (previous?.outcome === "sent") {
      if (previous.fingerprint !== attempt.fingerprint) return {
        record: { ...attempt, outcome: "rejected", reason: "client_id_reused", http_status: 409 },
      };
      return { record: { ...previous, duplicate: true } };
    }
    // Changing part or text must not turn an ambiguous send into another channel message.
    const unresolved = all.find((r) => r.outcome === "uncertain");
    if (unresolved) return { record: unresolved };
    const legacy = meta.replies.find((r) => r.part === attempt.part);
    if (legacy) return {
      record: { ...attempt, outcome: "sent", reason: "previously_recorded_receipt",
        relay_id: legacy.relay_id, duplicate: true },
    };
    await tx.put(attemptKey(meta.id, attempt.part), attempt);
    return { send: true };
  });
}
