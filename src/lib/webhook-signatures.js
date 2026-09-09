import "server-only";

import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { getPlaidVerificationKey } from "./providers/plaid";

export {
  verifyIncreaseSignature,
  verifyPersonaSignature,
} from "./hmac-signatures";

function sameText(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url");
}

export async function verifyPlaidSignature(rawBody, token) {
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = (token || "").split(".");
    if (!encodedSignature) return false;
    const header = JSON.parse(decodeBase64Url(encodedHeader));
    const payload = JSON.parse(decodeBase64Url(encodedPayload));
    if (header.alg !== "ES256" || Math.abs(Date.now() / 1000 - payload.iat) > 300) return false;

    const response = await getPlaidVerificationKey(header.kid);
    const publicKey = createPublicKey({ key: response.key, format: "jwk" });
    const validJwt = verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      decodeBase64Url(encodedSignature),
    );
    const bodyHash = createHash("sha256").update(rawBody).digest("hex");
    return validJwt && sameText(bodyHash, payload.request_body_sha256);
  } catch {
    return false;
  }
}
