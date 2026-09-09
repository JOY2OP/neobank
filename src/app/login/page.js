import { loginAction } from "@/app/actions";
import { Brand } from "@/components/ui";
import { DEMO_USERS } from "@/lib/demo-users";

export default function LoginPage() {
  return (
    <main className="login-page">
      <section className="login-story">
        <Brand />
        <div className="login-copy">
          <span className="eyebrow">US business banking · sandbox</span>
          <h1>Money movement you can explain.</h1>
          <p>Follow every hold, payment, approval, correction, and reconciliation break back to an immutable event.</p>
        </div>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <span className="eyebrow">Demo access</span>
          <h2>Choose who you are</h2>
          <p>No password is used in this work-trial demo.</p>
          <form action={loginAction}>
            <label htmlFor="user">Demo identity</label>
            <select id="user" name="user" defaultValue="sarah">
              {Object.values(DEMO_USERS).map((user) => (
                <option value={user.slug} key={user.slug}>{user.name} — {user.role}</option>
              ))}
            </select>
            <button className="button button-primary">Continue to dashboard</button>
          </form>
          <div className="login-hint"><strong>Three views, one source of truth.</strong><br />Sarah and John share Acme’s portal. Maya uses the Ops console.</div>
        </div>
      </section>
    </main>
  );
}
