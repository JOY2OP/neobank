import { runDueStandingOrders } from "@/lib/standing-orders";

export async function POST(request) {
  const supplied = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || supplied !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return Response.json({ results: await runDueStandingOrders() });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
