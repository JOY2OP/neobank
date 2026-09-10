"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { DEMO_IDS, getDemoUser } from "@/lib/demo-users";
import { recordIncreaseAchTransfer } from "@/lib/increase-events";
import { dollarsToCents } from "@/lib/money";
import { newIdempotencyKey, submitPaymentRequest } from "@/lib/payments";
import { startPersonaInquiry } from "@/lib/providers/persona";
import { clearLithicAuthorization, createLithicTestAuthorization, issueLithicCard, returnLithicTransaction } from "@/lib/providers/lithic";
import { createIncreaseFundingTransfer, retrieveIncreaseObject, simulateIncreaseTransfer } from "@/lib/providers/increase";
import { providerMode } from "@/lib/providers/config";
import { simulatedId, simulatedProviderEvent } from "@/lib/providers/simulator";
import { clearDemoSession, requireCustomer, requireOps, requireOwner, setDemoSession } from "@/lib/session";
import { runDueStandingOrders } from "@/lib/standing-orders";
import { callRpc, insertRows, selectRows } from "@/lib/supabase";

function resultError(error) {
  return { error: error instanceof Error ? error.message : "Something went wrong." };
}

export async function loginAction(formData) {
  const slug = String(formData.get("user") || "");
  const user = getDemoUser(slug);
  if (!user) redirect("/login?error=Choose+a+demo+user");
  await setDemoSession(slug);
  redirect(user.portal === "ops" ? "/ops" : "/app");
}

export async function logoutAction() {
  await clearDemoSession();
  redirect("/login");
}

export async function createPaymentAction(_previous, formData) {
  try {
    const user = await requireCustomer();
    const amountCents = dollarsToCents(formData.get("amount"));
    const beneficiaryId = String(formData.get("beneficiary") || "");
    const formKey = String(formData.get("idempotencyKey") || "");
    if (!beneficiaryId) throw new Error("Choose a beneficiary.");
    if (!formKey) throw new Error("Refresh the payment form and try again.");

    const created = await callRpc("create_payment_request", {
      p_business_account_id: DEMO_IDS.account,
      p_beneficiary_id: beneficiaryId,
      p_rail_code: "ACH",
      p_initiated_by_actor_id: user.actorId,
      p_amount_cents: amountCents,
      p_requested_execution_date: String(formData.get("executionDate")),
      p_idempotency_key: `payment-request:${formKey}`,
      p_memo: String(formData.get("memo") || ""),
    });
    const request = Array.isArray(created) ? created[0] : created;
    if (!request.requires_approval) await submitPaymentRequest(request.payment_request_id, user.actorId);
    revalidatePath("/app");
    revalidatePath("/core-loop");
    return {
      message: request.requires_approval
        ? "Payment added to Sarah's approval queue."
        : "Payment submitted to Increase.",
    };
  } catch (error) {
    return resultError(error);
  }
}

export async function decidePaymentAction(_previous, formData) {
  try {
    const user = await requireOwner();
    const decision = String(formData.get("decision"));
    const reason = String(formData.get("reason") || "").trim();
    if (decision === "REJECTED" && !reason) throw new Error("A rejection reason is required.");

    const paymentRequestId = String(formData.get("paymentRequestId"));
    await callRpc("decide_payment_request", {
      p_payment_request_id: paymentRequestId,
      p_approver_actor_id: user.actorId,
      p_decision: decision,
      p_idempotency_key: `approval:${paymentRequestId}:${decision}`,
      p_reason: reason || null,
      p_decided_at: new Date().toISOString(),
    });
    if (decision === "APPROVED") await submitPaymentRequest(paymentRequestId, user.actorId);
    revalidatePath("/app/approvals");
    revalidatePath("/app");
    revalidatePath("/core-loop");
    return { message: decision === "APPROVED" ? "Payment approved and submitted." : "Payment rejected." };
  } catch (error) {
    return resultError(error);
  }
}

export async function retryPaymentAction(_previous, formData) {
  try {
    const user = await requireOwner();
    const requestId = String(formData.get("paymentRequestId") || "");
    const statuses = await selectRows("payment_request_status", `id=eq.${requestId}`);
    if (statuses[0]?.status !== "APPROVED") {
      throw new Error("Only an approved payment with no provider submission can be retried.");
    }
    await submitPaymentRequest(requestId, user.actorId);
    revalidatePath("/app/approvals");
    revalidatePath("/app/payments");
    return { message: "Approved payment submitted successfully." };
  } catch (error) {
    return resultError(error);
  }
}

export async function issueCardAction(_previous, formData) {
  try {
    await requireOwner();
    const slug = String(formData.get("cardholder"));
    const cardholder = getDemoUser(slug);
    if (!cardholder || cardholder.portal !== "customer") throw new Error("Choose a customer cardholder.");
    const issued = await issueLithicCard(cardholder);
    const rows = await insertRows("cards", [{
      business_account_id: DEMO_IDS.account,
      cardholder_actor_id: cardholder.actorId,
      provider_code: issued.source === "SANDBOX" ? "lithic" : "simulator",
      provider_card_id: issued.cardId,
      last4: issued.last4,
    }]);
    await insertRows("card_events", [{
      card_id: rows[0].id,
      actor_id: DEMO_IDS.sarah,
      idempotency_key: `card-issued:${issued.cardId}`,
      event_type: "ACTIVATED",
      occurred_at: new Date().toISOString(),
      details: { account_token: issued.accountToken, provider_status: "OPEN", source: issued.source },
    }]);
    revalidatePath("/app/cards");
    revalidatePath("/core-loop");
    return { message: `${cardholder.name}'s ${issued.source.toLowerCase()} card was issued.` };
  } catch (error) {
    return resultError(error);
  }
}

export async function startKybAction() {
  try {
    await requireOwner();
    const inquiry = await startPersonaInquiry(DEMO_IDS.organization);
    await insertRows("kyb_cases", [{
      organization_id: DEMO_IDS.organization,
      provider_code: inquiry.source === "SANDBOX" ? "persona" : "simulator",
      external_case_id: inquiry.inquiryId,
    }], { ignoreDuplicates: true });
    revalidatePath("/core-loop");
    return { message: "Persona inquiry created.", url: inquiry.url };
  } catch (error) {
    return resultError(error);
  }
}

export async function createStandingOrderAction(_previous, formData) {
  try {
    const user = await requireCustomer();
    const orderId = randomUUID();
    const cadence = String(formData.get("cadence"));
    if (!["WEEKLY", "MONTHLY"].includes(cadence)) throw new Error("Choose weekly or monthly.");
    const amountCents = dollarsToCents(formData.get("amount"));
    const beneficiaryId = String(formData.get("beneficiary") || "");
    const beneficiaries = await selectRows(
      "beneficiaries",
      `id=eq.${beneficiaryId}&organization_id=eq.${DEMO_IDS.organization}`,
    );
    if (!beneficiaries[0]) throw new Error("Choose an Acme beneficiary.");
    const accountStatuses = await selectRows(
      "current_business_account_status",
      `business_account_id=eq.${DEMO_IDS.account}`,
    );
    if (!["OPENED", "UNRESTRICTED"].includes(accountStatuses[0]?.status)) {
      throw new Error("Standing orders cannot be created while the account is restricted.");
    }
    await insertRows("standing_orders", [{
      id: orderId,
      business_account_id: DEMO_IDS.account,
      beneficiary_id: beneficiaryId,
      rail_code: "ACH",
      created_by_actor_id: user.actorId,
      amount_cents: amountCents,
      schedule_rule: cadence,
      starts_on: String(formData.get("startsOn")),
      ends_on: String(formData.get("endsOn") || "") || null,
    }]);
    await insertRows("standing_order_events", [{
      standing_order_id: orderId,
      actor_id: user.actorId,
      idempotency_key: `standing-created:${orderId}`,
      event_type: "CREATED",
      occurred_at: new Date().toISOString(),
      details: { cadence },
    }]);
    revalidatePath("/app/standing-orders");
    return { message: "Standing order created." };
  } catch (error) {
    return resultError(error);
  }
}

export async function fundAccountAction(_previous, formData) {
  try {
    const owner = await requireOwner();
    const amountCents = dollarsToCents(formData.get("amount"));
    const bankId = String(formData.get("bankId") || "");
    const idempotencyKey = String(formData.get("idempotencyKey") || "");
    if (!bankId || !idempotencyKey) throw new Error("Choose a linked bank and try again.");

    // Repeat the organization check in this mutation; hidden form values are not trusted.
    const banks = await selectRows(
      "external_bank_accounts",
      `id=eq.${bankId}&organization_id=eq.${DEMO_IDS.organization}`,
    );
    if (!banks[0]) throw new Error("Linked bank not found.");
    const events = await selectRows(
      "external_bank_account_events",
      `external_bank_account_id=eq.${bankId}&order=recorded_at.desc&limit=1`,
    );
    const externalAccountId = events[0]?.details?.increase_external_account_id;
    if (!externalAccountId) throw new Error("This bank must be linked again before it can fund the account.");

    const transfer = await createIncreaseFundingTransfer({
      externalAccountId,
      amountCents,
      idempotencyKey: `increase:${idempotencyKey}`,
    });
    await callRpc("record_payment_event", {
      p_payment_idempotency_key: `funding:${idempotencyKey}`,
      p_event_idempotency_key: `funding-submitted:${idempotencyKey}`,
      p_business_account_id: DEMO_IDS.account,
      p_direction: "INBOUND",
      p_rail_code: "ACH",
      p_amount_cents: amountCents,
      p_event_type: "SUBMITTED",
      p_occurred_at: new Date().toISOString(),
      p_provider_code: transfer.source === "SANDBOX" ? "increase" : "simulator",
      p_provider_payment_id: transfer.id,
      p_actor_id: owner.actorId,
      p_details: { source: transfer.source, linked_bank_id: bankId },
      p_rail_details: { provider_transfer_id: transfer.id, sec_code: "CCD" },
    });
    revalidatePath("/app");
    revalidatePath("/app/banks");
    revalidatePath("/core-loop");
    return { message: "Funding pull submitted. Settle it below to make the sandbox funds available." };
  } catch (error) {
    return resultError(error);
  }
}

export async function settleIncreaseFundingAction(_previous, formData) {
  try {
    const owner = await requireOwner();
    if (providerMode("increase") !== "sandbox") {
      throw new Error("Set INCREASE_MODE=sandbox to settle a real Increase sandbox pull.");
    }
    const paymentId = String(formData.get("paymentId") || "");
    if (!paymentId) throw new Error("Choose a pending funding pull.");

    const payments = await selectRows(
      "payments",
      `id=eq.${paymentId}&business_account_id=eq.${DEMO_IDS.account}&direction=eq.INBOUND&provider_code=eq.increase`,
    );
    const payment = payments[0];
    if (!payment?.provider_payment_id) throw new Error("Increase funding pull not found.");

    const statuses = await selectRows("current_payment_status", `payment_id=eq.${payment.id}`);
    if (statuses[0]?.status === "SETTLED") return { message: "This funding pull is already settled." };

    let transfer = await retrieveIncreaseObject("ach_transfer", payment.provider_payment_id);
    if (!transfer.settlement?.settled_at) {
      transfer = await simulateIncreaseTransfer(transfer.id, "settle");
    }
    if (!transfer.settlement?.settled_at) {
      throw new Error("Increase accepted the simulation but did not mark the pull settled yet.");
    }

    await recordIncreaseAchTransfer({
      transfer,
      eventId: `sandbox-settle:${transfer.id}`,
      eventCreatedAt: transfer.settlement.settled_at,
      actorId: owner.actorId,
    });
    revalidatePath("/app");
    revalidatePath("/app/banks");
    revalidatePath("/core-loop");
    return { message: "Increase settled the sandbox pull and Corgi updated the available balance." };
  } catch (error) {
    return resultError(error);
  }
}

function parseReconciliationCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift()?.split(",").map((value) => value.trim());
  if (header?.join(",") !== "processor_reference,amount_cents,value_date") {
    throw new Error("CSV header must be processor_reference,amount_cents,value_date");
  }
  return lines.map((line, index) => {
    const [processor_reference, amountText, value_date] = line.split(",").map((value) => value.trim());
    const amount_cents = Number(amountText);
    if (!processor_reference || !Number.isSafeInteger(amount_cents) || amount_cents <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(value_date)) {
      throw new Error(`Invalid reconciliation row ${index + 2}.`);
    }
    return { processor_reference, amount_cents, value_date };
  });
}

export async function runReconciliationAction(_previous, formData) {
  try {
    await requireOps();
    const file = formData.get("file");
    if (!file || typeof file.text !== "function") throw new Error("Choose a CSV file.");
    if (file.size > 1024 * 1024) throw new Error("Reconciliation files are limited to 1 MB.");
    const text = await file.text();
    const rows = parseReconciliationCsv(text);
    await callRpc("run_scheme_reconciliation", {
      p_provider_code: String(formData.get("provider") || "lithic"),
      p_settlement_date: String(formData.get("settlementDate")),
      p_file_reference: file.name,
      p_file_hash: createHash("sha256").update(text).digest("hex"),
      p_rows: rows,
    });
    revalidatePath("/ops/reconciliation");
    return { message: `Reconciled ${rows.length} scheme rows.` };
  } catch (error) {
    return resultError(error);
  }
}

async function storeSimulatedEvent(event) {
  const saved = await callRpc("ingest_provider_event", {
    p_provider_code: "simulator",
    p_provider_account: "demo-lab",
    p_environment: "SIMULATED",
    p_external_event_id: event.id,
    p_event_type: event.eventType,
    p_provider_created_at: event.createdAt,
    p_signature_verified: true,
    p_payload: event.payload,
  });
  return Array.isArray(saved) ? saved[0] : saved;
}

async function ingestSimulatedEvent(event) {
  return (await storeSimulatedEvent(event)).provider_event_id;
}

export async function runDemoAction(_previous, formData) {
  try {
    const ops = await requireOps();
    const scenario = String(formData.get("scenario"));
    if (scenario === "standing-orders") {
      const results = await runDueStandingOrders();
      revalidatePath("/ops/demo-lab");
      return { message: `Processed ${results.length} due standing-order item(s).` };
    }
    if (scenario === "nsf-retry") {
      const retryTime = new Date(Date.now() + 25 * 60 * 60 * 1000);
      const results = await runDueStandingOrders(retryTime);
      revalidatePath("/app/standing-orders");
      return { message: `Ran ${results.length} retry item(s); a second NSF pauses its order.` };
    }

    if (scenario === "duplicate-webhook") {
      const event = {
        ...simulatedProviderEvent("simulator", "issuing.webhook.duplicate", { amount_cents: 1234 }),
        id: "demo_duplicate_event",
      };
      const firstDelivery = await storeSimulatedEvent(event);
      const cards = await selectRows("cards", "provider_code=eq.simulator&order=created_at.asc&limit=1");
      if (!cards[0]) throw new Error("Run the seed script first; the duplicate demo needs its simulator card.");
      if (firstDelivery.inserted) {
        const occurredAt = new Date().toISOString();
        await callRpc("record_card_settlement", {
          p_provider_code: "simulator",
          p_provider_settlement_id: "demo_duplicate_force_post",
          p_card_id: cards[0].id,
          p_external_authorization_id: null,
          p_amount_cents: 1234,
          p_value_date: occurredAt.slice(0, 10),
          p_occurred_at: occurredAt,
          p_explicit_force_post: true,
          p_is_final_capture: true,
          p_idempotency_key: "demo-duplicate-post",
          p_actor_id: ops.actorId,
          p_provider_event_id: firstDelivery.provider_event_id,
        });
        await callRpc("record_provider_event_attempt", {
          p_provider_event_id: firstDelivery.provider_event_id,
          p_attempt_number: 1,
          p_outcome: "SUCCEEDED",
          p_started_at: occurredAt,
          p_completed_at: new Date().toISOString(),
          p_details: { duplicate_delivery: true },
        });
      }
      await storeSimulatedEvent(event);
      revalidatePath("/ops/events");
      revalidatePath("/app");
      return { message: "Delivered the same $12.34 force-post twice; one inbox row and one journal posting exist." };
    }

    if (scenario === "ach-return") {
      const demoEvent = simulatedProviderEvent("simulator", "ach_transfer.returned", { return_code: "R01" });
      const providerEventId = await ingestSimulatedEvent(demoEvent);
      const requestKey = newIdempotencyKey("demo-ach-return-request");
      const created = await callRpc("create_payment_request", {
        p_business_account_id: DEMO_IDS.account,
        p_beneficiary_id: DEMO_IDS.beneficiary,
        p_rail_code: "ACH",
        p_initiated_by_actor_id: DEMO_IDS.john,
        p_amount_cents: 4200,
        p_requested_execution_date: new Date().toISOString().slice(0, 10),
        p_idempotency_key: requestKey,
        p_memo: "Demo returned ACH",
      });
      const request = Array.isArray(created) ? created[0] : created;
      const paymentKey = `payment:${request.payment_request_id}`;
      const providerId = simulatedId("ach_return");
      const common = {
        p_payment_idempotency_key: paymentKey,
        p_business_account_id: DEMO_IDS.account,
        p_direction: "OUTBOUND",
        p_rail_code: "ACH",
        p_amount_cents: 4200,
        p_payment_request_id: request.payment_request_id,
        p_provider_code: "simulator",
        p_provider_payment_id: providerId,
        p_actor_id: ops.actorId,
        p_provider_event_id: providerEventId,
        p_rail_details: { provider_transfer_id: providerId, sec_code: "CCD" },
      };
      await callRpc("record_payment_event", { ...common, p_event_idempotency_key: `${paymentKey}:submitted`, p_event_type: "SUBMITTED", p_occurred_at: new Date().toISOString() });
      await callRpc("record_payment_event", { ...common, p_event_idempotency_key: `${paymentKey}:settled`, p_event_type: "SETTLED", p_occurred_at: new Date().toISOString(), p_value_date: new Date().toISOString().slice(0, 10) });
      await callRpc("record_payment_event", { ...common, p_event_idempotency_key: `${paymentKey}:returned`, p_event_type: "RETURNED", p_occurred_at: new Date().toISOString(), p_value_date: new Date().toISOString().slice(0, 10), p_reason_code: "R01", p_rail_details: { provider_transfer_id: providerId, sec_code: "CCD", ach_return_code: "R01" } });
      await callRpc("record_provider_event_attempt", { p_provider_event_id: providerEventId, p_attempt_number: 1, p_outcome: "SUCCEEDED", p_started_at: new Date().toISOString(), p_completed_at: new Date().toISOString(), p_details: {} });
      revalidatePath("/app");
      return { message: "Settled then returned the demo ACH with R01 as an append-only reversal." };
    }

    const cards = await selectRows("cards", "provider_code=eq.simulator&order=created_at.asc&limit=1");
    if (!cards[0]) throw new Error("Run the seed script first; the Demo Lab needs its simulator card.");
    const card = cards[0];
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const domainProviderEventId = scenario === "provider-delay"
      ? null
      : await ingestSimulatedEvent(simulatedProviderEvent("simulator", `demo.${scenario}`, { scenario }));

    if (scenario === "authorization" || scenario === "out-of-order") {
      const authorizationId = simulatedId("auth");
      if (scenario === "out-of-order") {
        await callRpc("record_card_settlement", {
          p_provider_code: "simulator",
          p_provider_settlement_id: simulatedId("settlement"),
          p_card_id: card.id,
          p_external_authorization_id: authorizationId,
          p_amount_cents: 3200,
          p_value_date: today,
          p_occurred_at: now.toISOString(),
          p_explicit_force_post: false,
          p_is_final_capture: true,
          p_idempotency_key: newIdempotencyKey("out-of-order-settlement"),
          p_actor_id: ops.actorId,
          p_provider_event_id: domainProviderEventId,
        });
      }
      await callRpc("record_authorization_event", {
        p_provider_code: "simulator",
        p_provider_authorization_id: authorizationId,
        p_card_id: card.id,
        p_event_type: "AUTHORIZED",
        p_authorized_total_cents: scenario === "authorization" ? 5000 : 3200,
        p_occurred_at: now.toISOString(),
        p_idempotency_key: newIdempotencyKey("demo-authorization"),
        p_merchant_name: "Corgi Fuel Stop",
        p_merchant_category_code: "5542",
        p_details: { source: "SIMULATED", out_of_order: scenario === "out-of-order" },
        p_provider_event_id: domainProviderEventId,
      });
    } else if (scenario === "capture") {
      const auths = await selectRows("card_authorizations", `card_id=eq.${card.id}&order=first_seen_at.desc&limit=1`);
      if (!auths[0]) throw new Error("Create an authorization first.");
      await callRpc("record_card_settlement", {
        p_provider_code: "simulator",
        p_provider_settlement_id: simulatedId("settlement"),
        p_card_id: card.id,
        p_external_authorization_id: auths[0].provider_authorization_id,
        p_amount_cents: 7340,
        p_value_date: today,
        p_occurred_at: now.toISOString(),
        p_explicit_force_post: false,
        p_is_final_capture: true,
        p_idempotency_key: newIdempotencyKey("demo-capture"),
        p_actor_id: ops.actorId,
        p_provider_event_id: domainProviderEventId,
      });
    } else if (scenario === "reversal") {
      const settlements = await selectRows("card_settlements", `card_id=eq.${card.id}&order=recorded_at.desc&limit=1`);
      if (!settlements[0]) throw new Error("Create a capture first.");
      await callRpc("reverse_card_settlement", {
        p_settlement_id: settlements[0].id,
        p_idempotency_key: `demo-reversal:${settlements[0].id}`,
        p_value_date: settlements[0].value_date,
        p_reason: "Merchant reversed the settled transaction",
        p_actor_id: ops.actorId,
        p_provider_event_id: domainProviderEventId,
      });
    } else if (scenario === "force-post") {
      await callRpc("record_card_settlement", {
        p_provider_code: "simulator",
        p_provider_settlement_id: simulatedId("force"),
        p_card_id: card.id,
        p_external_authorization_id: null,
        p_amount_cents: 1899,
        p_value_date: today,
        p_occurred_at: now.toISOString(),
        p_explicit_force_post: true,
        p_is_final_capture: true,
        p_idempotency_key: newIdempotencyKey("force-post"),
        p_actor_id: ops.actorId,
        p_provider_event_id: domainProviderEventId,
      });
    } else if (scenario === "provider-delay") {
      const event = simulatedProviderEvent("simulator", "issuing.webhook.delayed", { expected_minutes: 5 });
      const providerEventId = await ingestSimulatedEvent(event);
      await callRpc("record_provider_event_attempt", {
        p_provider_event_id: providerEventId,
        p_attempt_number: 1,
        p_outcome: "RETRYABLE_FAILURE",
        p_started_at: now.toISOString(),
        p_completed_at: now.toISOString(),
        p_error_code: "PROVIDER_TIMEOUT",
        p_error_message: "Provider updates are delayed; ledger state remains unchanged.",
        p_details: { source: "SIMULATED" },
      });
    } else {
      throw new Error("Unknown demo scenario.");
    }

    if (domainProviderEventId) {
      await callRpc("record_provider_event_attempt", {
        p_provider_event_id: domainProviderEventId,
        p_attempt_number: 1,
        p_outcome: "SUCCEEDED",
        p_started_at: now.toISOString(),
        p_completed_at: new Date().toISOString(),
        p_details: { scenario },
      });
    }

    revalidatePath("/ops");
    revalidatePath("/ops/demo-lab");
    revalidatePath("/app");
    return { message: `${scenario} completed in the clearly labeled simulator.` };
  } catch (error) {
    return resultError(error);
  }
}

export async function providerSummary() {
  return ["persona", "plaid", "lithic", "increase"].map((name) => ({
    name,
    mode: providerMode(name),
  }));
}

function requireLithicSandbox() {
  if (providerMode("lithic") !== "sandbox") {
    throw new Error("Set LITHIC_MODE=sandbox. Simulator activity does not complete the core loop.");
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredUuid(formData, name, label) {
  const value = String(formData.get(name) || "");
  if (!UUID_PATTERN.test(value)) throw new Error(`Choose a valid ${label}.`);
  return value;
}

async function lithicCardForTerminal(cardId) {
  const cards = await selectRows(
    "cards",
    `id=eq.${cardId}&business_account_id=eq.${DEMO_IDS.account}&provider_code=eq.lithic&limit=1`,
  );
  if (!cards[0]) throw new Error("Choose a Lithic card issued to an Acme team member.");
  const statuses = await selectRows("current_card_status", `card_id=eq.${cardId}&limit=1`);
  if (!["ACTIVATED", "UNFROZEN"].includes(statuses[0]?.status)) {
    throw new Error("The selected card is not active in Corgi.");
  }
  return cards[0];
}

function revalidateLithicViews() {
  revalidatePath("/ops");
  revalidatePath("/ops/demo-lab");
  revalidatePath("/ops/events");
  revalidatePath("/app");
  revalidatePath("/app/cards");
  revalidatePath("/core-loop");
}

export async function lithicSandboxAuthorizeAction(_previous, formData) {
  try {
    const ops = await requireOps();
    requireLithicSandbox();
    const cardId = requiredUuid(formData, "cardId", "Lithic card");
    const card = await lithicCardForTerminal(cardId);
    const amountCents = dollarsToCents(formData.get("amount"));
    const descriptor = String(formData.get("descriptor") || "").trim();
    const authorization = await createLithicTestAuthorization(card.provider_card_id, amountCents, descriptor);
    const eventType = authorization.approved ? "AUTHORIZED" : "DECLINED";
    await callRpc("record_authorization_event", {
      p_provider_code: "lithic",
      p_provider_authorization_id: authorization.id,
      p_card_id: card.id,
      p_event_type: eventType,
      p_authorized_total_cents: authorization.approved ? amountCents : null,
      p_occurred_at: authorization.created || new Date().toISOString(),
      p_idempotency_key: `lithic:authorization:${authorization.eventId}:${eventType}`,
      p_merchant_name: authorization.merchantName,
      p_merchant_category_code: authorization.merchantCategoryCode,
      p_details: { source: "SANDBOX", triggered_by: "ops-terminal", actor_id: ops.actorId },
    });
    revalidateLithicViews();
    if (!authorization.approved) {
      throw new Error(`Lithic declined the authorization (${authorization.result || "unknown result"}).`);
    }
    return { message: `Lithic authorized card •••• ${card.last4}. The amount is now an active hold.` };
  } catch (error) {
    return resultError(error);
  }
}

export async function lithicSandboxClearAction(_previous, formData) {
  try {
    const ops = await requireOps();
    requireLithicSandbox();
    const authorizationId = requiredUuid(formData, "authorizationId", "pending authorization");
    const authorizations = await selectRows(
      "card_authorizations",
      `id=eq.${authorizationId}&provider_code=eq.lithic&limit=1`,
    );
    if (!authorizations[0]) throw new Error("Choose a pending Lithic authorization.");
    const authorization = authorizations[0];
    const card = await lithicCardForTerminal(authorization.card_id);
    const holds = await selectRows(
      "active_card_holds",
      `authorization_id=eq.${authorization.id}&business_account_id=eq.${DEMO_IDS.account}&limit=1`,
    );
    if (!holds[0]) throw new Error("That authorization no longer has an active hold.");
    const amountCents = dollarsToCents(formData.get("amount"));
    const clearing = await clearLithicAuthorization(authorization.provider_authorization_id, amountCents);
    await callRpc("record_card_settlement", {
      p_provider_code: "lithic",
      p_provider_settlement_id: clearing.id,
      p_card_id: card.id,
      p_external_authorization_id: authorization.provider_authorization_id,
      p_amount_cents: amountCents,
      p_value_date: clearing.created.slice(0, 10),
      p_occurred_at: clearing.created || new Date().toISOString(),
      p_explicit_force_post: false,
      p_is_final_capture: true,
      p_idempotency_key: `lithic:clearing:${clearing.id}`,
      p_actor_id: ops.actorId,
    });
    revalidateLithicViews();
    return { message: `Lithic cleared card •••• ${card.last4}. Corgi posted the settlement and released its hold.` };
  } catch (error) {
    return resultError(error);
  }
}

export async function lithicSandboxReturnAction(_previous, formData) {
  try {
    const ops = await requireOps();
    requireLithicSandbox();
    const settlementId = requiredUuid(formData, "settlementId", "settled card purchase");
    const settlements = await selectRows(
      "card_settlements",
      `id=eq.${settlementId}&business_account_id=eq.${DEMO_IDS.account}&provider_code=eq.lithic&limit=1`,
    );
    if (!settlements[0]) throw new Error("Choose a settled Lithic card purchase.");
    const settlement = settlements[0];
    const priorReversals = await selectRows(
      "card_settlement_events",
      `settlement_id=eq.${settlement.id}&event_type=eq.REVERSED&limit=1`,
    );
    if (priorReversals[0]) throw new Error("That settlement has already been returned.");
    const card = await lithicCardForTerminal(settlement.card_id);
    const returned = await returnLithicTransaction(card.provider_card_id, settlement.amount_cents);
    await callRpc("reverse_card_settlement", {
      p_settlement_id: settlement.id,
      p_idempotency_key: `lithic:return:${returned.id}`,
      p_value_date: settlement.value_date,
      p_reason: "Lithic sandbox return",
      p_actor_id: ops.actorId,
    });
    revalidateLithicViews();
    return { message: `Lithic returned the purchase on card •••• ${card.last4}. Corgi appended the correction.` };
  } catch (error) {
    return resultError(error);
  }
}

export async function coreAuthorizeCardAction() {
  try {
    const ops = await requireOps();
    requireLithicSandbox();
    const cards = await selectRows("cards", `business_account_id=eq.${DEMO_IDS.account}&provider_code=eq.lithic&order=created_at.desc&limit=1`);
    if (!cards[0]) throw new Error("Issue a Lithic sandbox card first.");
    const authorization = await createLithicTestAuthorization(cards[0].provider_card_id, 5000);
    const authorizationEvent = authorization.approved ? "AUTHORIZED" : "DECLINED";
    await callRpc("record_authorization_event", {
      p_provider_code: "lithic",
      p_provider_authorization_id: authorization.id,
      p_card_id: cards[0].id,
      p_event_type: authorizationEvent,
      p_authorized_total_cents: authorization.approved === false ? null : 5000,
      p_occurred_at: authorization.created || new Date().toISOString(),
      p_idempotency_key: `lithic:authorization:${authorization.eventId}:${authorizationEvent}`,
      p_merchant_name: authorization.merchantName,
      p_merchant_category_code: authorization.merchantCategoryCode,
      p_details: { source: "SANDBOX", triggered_by: "core-loop", actor_id: ops.actorId },
    });
    revalidatePath("/core-loop");
    if (authorizationEvent === "DECLINED") {
      throw new Error(`Lithic declined the $50.00 test authorization (${authorization.result || "unknown result"}). Check the sandbox account and card limits.`);
    }
    return { message: "Lithic authorized $50.00 and Corgi placed the hold." };
  } catch (error) { return resultError(error); }
}

export async function coreSettleCardAction() {
  try {
    const ops = await requireOps();
    requireLithicSandbox();
    const activeHolds = await selectRows("active_card_holds", `business_account_id=eq.${DEMO_IDS.account}&order=last_recorded_at.desc`);
    if (!activeHolds.length) throw new Error("Create an approved Lithic authorization with an active hold first.");
    const activeAuthorizationIds = activeHolds.map((hold) => hold.authorization_id).join(",");
    const auths = await selectRows("card_authorizations", `id=in.(${activeAuthorizationIds})&provider_code=eq.lithic&order=first_seen_at.desc&limit=1`);
    if (!auths[0]) throw new Error("No active hold belongs to a Lithic authorization.");
    const clearing = await clearLithicAuthorization(auths[0].provider_authorization_id, 7340);
    await callRpc("record_card_settlement", {
      p_provider_code: "lithic",
      p_provider_settlement_id: clearing.id,
      p_card_id: auths[0].card_id,
      p_external_authorization_id: auths[0].provider_authorization_id,
      p_amount_cents: 7340,
      p_value_date: clearing.created.slice(0, 10),
      p_occurred_at: clearing.created || new Date().toISOString(),
      p_explicit_force_post: false,
      p_is_final_capture: true,
      p_idempotency_key: `lithic:clearing:${clearing.id}`,
      p_actor_id: ops.actorId,
    });
    revalidatePath("/core-loop");
    return { message: "Lithic cleared $73.40; Corgi released the $50 hold and booked the provider value date." };
  } catch (error) { return resultError(error); }
}

export async function coreReverseSettlementAction() {
  try {
    const ops = await requireOps();
    requireLithicSandbox();
    const settlements = await selectRows("card_settlements", "provider_code=eq.lithic&order=recorded_at.desc&limit=1");
    if (!settlements[0]) throw new Error("Settle the Lithic authorization first.");
    const cards = await selectRows("cards", `id=eq.${settlements[0].card_id}&provider_code=eq.lithic&limit=1`);
    if (!cards[0]) throw new Error("The settlement's Lithic card is missing.");
    const returned = await returnLithicTransaction(cards[0].provider_card_id, settlements[0].amount_cents);
    await callRpc("reverse_card_settlement", {
      p_settlement_id: settlements[0].id,
      p_idempotency_key: `lithic:return:${returned.id}`,
      p_value_date: settlements[0].value_date,
      p_reason: "Lithic sandbox return",
      p_actor_id: ops.actorId,
    });
    revalidatePath("/core-loop");
    return { message: "Lithic emitted a return and Corgi appended the settlement reversal." };
  } catch (error) { return resultError(error); }
}

export async function coreReconcileAction() {
  try {
    await requireOps();
    const settlements = await selectRows("card_settlements", "provider_code=eq.lithic&order=recorded_at.desc&limit=1");
    if (!settlements[0]) throw new Error("Settle a Lithic transaction first.");
    const row = { processor_reference: settlements[0].provider_settlement_id, amount_cents: settlements[0].amount_cents, value_date: settlements[0].value_date };
    const body = JSON.stringify(row);
    await callRpc("run_scheme_reconciliation", {
      p_provider_code: "lithic",
      p_settlement_date: settlements[0].value_date,
      p_file_reference: `lithic-core-loop-${settlements[0].value_date}.csv`,
      p_file_hash: createHash("sha256").update(body).digest("hex"),
      p_rows: [row],
    });
    revalidatePath("/core-loop");
    revalidatePath("/ops/reconciliation");
    return { message: "The generated Lithic processor row reconciled against the immutable settlement." };
  } catch (error) { return resultError(error); }
}
