import { createHmac, timingSafeEqual } from "node:crypto";

function sign(slug, secret) {
  return createHmac("sha256", secret).update(slug).digest("hex");
}

export function createSignedSessionValue(slug, secret) {
  return `${slug}.${sign(slug, secret)}`;
}

export function readSignedSessionSlug(value, secret) {
  const parts = String(value || "").split(".");
  if (parts.length !== 2) return null;
  const [slug, receivedSignature] = parts;
  const expectedSignature = sign(slug, secret);
  if (receivedSignature.length !== expectedSignature.length) return null;
  const valid = timingSafeEqual(Buffer.from(receivedSignature), Buffer.from(expectedSignature));
  return valid ? slug : null;
}
