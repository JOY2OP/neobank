import "server-only";

import { providerMode, requiredEnv } from "./config";
import { simulatedId } from "./simulator";

// Persona owns the KYB screens. We create an inquiry here, then its webhook
// records the result in our database and unlocks the business account.
export async function startPersonaInquiry(referenceId) {
  if (providerMode("persona") === "simulated") {
    const inquiryId = simulatedId("inq");
    return { inquiryId, url: `/ops/demo-lab?inquiry=${inquiryId}`, source: "SIMULATED" };
  }

  const response = await fetch("https://api.withpersona.com/api/v1/inquiries", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("PERSONA_API_KEY")}`,
      "Persona-Version": "2023-01-05",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        attributes: {
          "inquiry-template-id": requiredEnv("PERSONA_TEMPLATE_ID"),
          "reference-id": referenceId,
        },
      },
    }),
  });

  if (!response.ok) throw new Error(`Persona sandbox error: ${await response.text()}`);
  const body = await response.json();
  const inquiryId = body.data.id;
  return {
    inquiryId,
    url: `https://withpersona.com/verify?inquiry-id=${inquiryId}`,
    source: "SANDBOX",
  };
}
