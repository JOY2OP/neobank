"use client";

export default function ErrorPage({ error, reset }) {
  return (
    <main className="page-content">
      <section className="panel error-panel">
        <span className="eyebrow">Something went wrong</span>
        <h1>This screen could not be loaded.</h1>
        <p>{error.message || "Check the local setup and try again."}</p>
        <button className="button button-primary" onClick={reset}>Try again</button>
      </section>
    </main>
  );
}
