import { createHmac, timingSafeEqual } from "node:crypto";

function sameText(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function verifyPersonaSignature(rawBody, header, secret) {
  return (header || "").split(" ").some((pair) => {
    const values = Object.fromEntries(pair.split(",").map((part) => part.split("=")));
    const timestamp = Number(values.t);
    if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
    const expected = createHmac("sha256", secret).update(`${values.t}.${rawBody}`).digest("hex");
    return sameText(expected, values.v1);
  });
}

export function verifyIncreaseSignature(rawBody, headers, secret) {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const received = headers.get("webhook-signature") || "";
  const expected = `v1,${createHmac("sha256", secret).update(`${id}.${timestamp}.${rawBody}`).digest("base64")}`;
  const timestampNumber = Number(timestamp);
  const recent = Number.isFinite(timestampNumber) && Math.abs(Date.now() / 1000 - timestampNumber) <= 300;
  return recent && received.split(" ").some((signature) => sameText(signature, expected));
}
