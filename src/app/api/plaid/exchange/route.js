import { revalidatePath } from "next/cache";
import { DEMO_IDS } from "@/lib/demo-users";
import { createIncreaseExternalAccount } from "@/lib/providers/increase";
import { exchangePlaidToken } from "@/lib/providers/plaid";
import { requireOwner } from "@/lib/session";
import { callRpc, insertRows, selectRows, updateRows } from "@/lib/supabase";

export async function POST(request) {
  try {
    await requireOwner();
    const { publicToken } = await request.json();
    const linked = await exchangePlaidToken(publicToken);
    const increaseAccount = await createIncreaseExternalAccount({
      name: linked.account.name,
      routing: linked.account.routing,
      number: linked.account.number,
      idempotencyKey: `plaid:${linked.itemId}`,
    });

    // The Plaid token stays server-only. Customer-facing tables retain only
    // masked details and the opaque Increase account used for ACH transfers.
    await callRpc("save_provider_connection_secret", {
      p_provider_code: "plaid",
      p_organization_id: DEMO_IDS.organization,
      p_external_connection_id: linked.itemId,
      p_access_token: linked.accessToken,
    });
    const insertedBanks = await insertRows("external_bank_accounts", [{
      organization_id: DEMO_IDS.organization,
      provider_code: linked.source === "SANDBOX" ? "plaid" : "simulator",
      provider_account_id: linked.account.id,
      institution_name: linked.account.name,
      account_name: "Business checking",
      account_mask: linked.account.mask,
    }], { ignoreDuplicates: true });
    const banks = insertedBanks.length ? insertedBanks : await selectRows(
      "external_bank_accounts",
      `provider_code=eq.${linked.source === "SANDBOX" ? "plaid" : "simulator"}&provider_account_id=eq.${linked.account.id}`,
    );
    if (banks[0]) {
      await insertRows("external_bank_account_events", [{
        external_bank_account_id: banks[0].id,
        idempotency_key: `bank-linked:${linked.itemId}`,
        event_type: "LINKED",
        occurred_at: new Date().toISOString(),
        details: { item_id: linked.itemId, increase_external_account_id: increaseAccount.id, source: linked.source },
      }], { ignoreDuplicates: true });

      // The guided demo sends its approved outbound ACH back to the same
      // sandbox bank. Persist the opaque Increase ID so the beneficiary is
      // provider-ready instead of pointing at the seed-only fake reference.
      await updateRows("beneficiaries", `id=eq.${DEMO_IDS.beneficiary}`, {
        provider_recipient_reference: increaseAccount.id,
        account_mask: linked.account.mask,
      });
    }
    revalidatePath("/core-loop");
    revalidatePath("/app/banks");
    return Response.json({ ok: true, source: linked.source });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}
