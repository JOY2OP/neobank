import { createPlaidLinkToken } from "@/lib/providers/plaid";
import { requireOwner } from "@/lib/session";

export async function POST() {
  try {
    const user = await requireOwner();
    return Response.json(await createPlaidLinkToken(user.actorId));
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}
