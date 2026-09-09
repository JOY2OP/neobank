import { decidePaymentAction, retryPaymentAction } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { EmptyState, SectionHeading, StatusPill } from "@/components/ui";
import { getApprovalQueue } from "@/lib/data";
import { formatDate, formatUsd } from "@/lib/money";
import { requireOwner } from "@/lib/session";

export default async function ApprovalsPage() {
  const user = await requireOwner();
  const requests = await getApprovalQueue();
  return <><SectionHeading eyebrow="Maker-checker" title="Approval queue" description="A payment always needs a second human; the maker can never approve their own request." />{requests.length ? <div className="approval-list">{requests.map((request) => <article className="approval-card" key={request.id}><div className="approval-summary"><div><StatusPill tone={request.status === "APPROVED" ? "success" : "warning"}>{request.status}</StatusPill><h2>{formatUsd(request.amount_cents)} to {request.beneficiary_name}</h2><p>Created by {request.initiator_name} on {formatDate(request.created_at)} · {request.memo || "No memo"}</p></div></div>{request.status === "APPROVED" ? <ActionForm action={retryPaymentAction} submitLabel="Retry provider submission" className="compact-form"><input type="hidden" name="paymentRequestId" value={request.id} /><p className="form-help">Funds are still reserved. Retry after correcting the Increase sandbox setup or a provider outage.</p></ActionForm> : request.initiated_by_actor_id === user.actorId ? <div className="notice notice-warning"><strong>Separation of duties</strong><span>You initiated this payment, so another owner or approver must decide it.</span></div> : <ActionForm action={decidePaymentAction} submitLabel="Submit decision" className="approval-form"><input type="hidden" name="paymentRequestId" value={request.id} /><label>Decision<select name="decision" defaultValue="APPROVED"><option value="APPROVED">Approve</option><option value="REJECTED">Reject</option></select></label><label>Reason<textarea name="reason" placeholder="Required when rejecting" rows={2} /></label></ActionForm>}</article>)}</div> : <EmptyState title="Approval queue is clear">Above-threshold payments created by John will appear here.</EmptyState>}</>;
}
