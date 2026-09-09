"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

function SubmitButton({ children }) {
  const { pending } = useFormStatus();
  return <button className="button button-primary" disabled={pending}>{pending ? "Working…" : children}</button>;
}

export function ActionForm({ action, submitLabel, children, className = "form-card" }) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className={className}>
      {children}
      {state?.error ? <p className="form-message error" role="alert">{state.error}</p> : null}
      {state?.message ? <p className="form-message success" role="status">{state.message}</p> : null}
      <SubmitButton>{submitLabel}</SubmitButton>
    </form>
  );
}
