// Reserve before POST so a lost response or process restart cannot trigger another send.
// Only hashes and delivery metadata are stored; message text is never persisted.
import { dayKey, sha256 } from "./util.js";

const recordKey = async (clientId) => `send:${await sha256(clientId)}`;
const pendingKey = (to) => `send-pending:${to}`;

export async function sendStatus(storage, clientId) {
  return storage.get(await recordKey(clientId));
}

export function publicSend(record) {
  const { fingerprint, ...safe } = record;
  return { relay_id: null, retry_allowed: false, ...safe };
}

export async function sendProactive(ctx, { to, text, hop, clientId }) {
  const key = await recordKey(clientId);
  const attempt = {
    to, hop, clientId, fingerprint: await sha256(JSON.stringify([to, text, hop])),
    outcome: "uncertain", reason: "in_flight", started_at: ctx.now(),
  };
  let reservation;
  try { reservation = await reserve(ctx, key, attempt); }
  catch { return { ...attempt, outcome: "rejected", reason: "storage_unavailable_before_send" }; }
  if (!reservation.send) return reservation.record;

  let result;
  try {
    // Separate the relay's client-id space from grok_reply's deterministic ids.
    result = await ctx.relay.send({ to, text, clientId: `grok-send-${key.slice(5, 53)}` });
  } catch {
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
    await ctx.storage.transaction(async (tx) => {
      await tx.put(key, record);
      if (record.outcome !== "uncertain") await tx.delete(pendingKey(to));
    });
  } catch {
    record.persistence = "receipt_not_saved";
  }
  ctx.log("send_result", publicSend(record));
  return record;
}

async function reserve(ctx, key, attempt) {
  return ctx.storage.transaction(async (tx) => {
    const previous = await tx.get(key);
    if (previous) return { record: previous.fingerprint === attempt.fingerprint
      ? { ...previous, duplicate: true }
      : { ...attempt, outcome: "rejected", reason: "client_id_reused" } };
    const pending = await tx.get(pendingKey(attempt.to));
    if (pending) return { record: {
      ...attempt, outcome: "rejected", reason: "recipient_has_unconfirmed_send", blocked_by: pending,
    } };
    const rateKey = `rate:send:${attempt.to}`;
    const day = dayKey(attempt.started_at, ctx.cfg.dayOffsetMs);
    const rate = await tx.get(rateKey) || { recent: [], day, count: 0 };
    const recent = rate.recent.filter((t) => t > attempt.started_at - ctx.cfg.sendWindowMs);
    const count = rate.day === day ? rate.count : 0;
    const reason = recent.length >= ctx.cfg.sendLimit ? "recipient_window_limit"
      : count >= ctx.cfg.sendDailyCap ? "recipient_daily_limit" : null;
    if (reason) return { record: { ...attempt, outcome: "rejected", reason } };
    await tx.put({
      [key]: attempt,
      [pendingKey(attempt.to)]: attempt.clientId,
      [rateKey]: { recent: [...recent, attempt.started_at], day, count: count + 1 },
    });
    return { send: true };
  });
}
