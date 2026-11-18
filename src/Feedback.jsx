import { useState } from "react";
import { Link } from "react-router-dom";

// Simple feedback box. In production this submits to Netlify's own Forms
// feature (the hidden decoy form in index.html registers it at build time),
// so every submission shows up in the Netlify dashboard's Forms tab — no
// server or email service of our own needed, and you can turn on an email
// notification per submission right there in Site settings. Locally
// (`npm run dev`) there is no such thing as Netlify Forms, so it posts to
// /api/feedback instead (server/feedback.js), to keep the feature testable.
function Feedback() {
  const [message, setMessage] = useState("");
  const [state, setState] = useState("idle"); // idle | sending | sent | error

  async function submit(e) {
    e.preventDefault();
    if (!message.trim()) return;
    setState("sending");
    try {
      const res = import.meta.env.DEV
        ? await fetch("/api/feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
          })
        : await fetch("/", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ "form-name": "feedback", message }).toString(),
          });
      if (!res.ok) throw new Error();
      setMessage("");
      setState("sent");
    } catch {
      setState("error");
    }
  }

  return (
    <main className="page">
      <Link to="/">← Back</Link>
      <form className="feedback" onSubmit={submit}>
        <h2>Feedback</h2>
        <textarea
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            setState("idle");
          }}
          maxLength={2000}
          rows={4}
          placeholder="Tell us what works, what doesn't, or what you'd like to see…"
        />
        <button
          className="add-button"
          disabled={!message.trim() || state === "sending"}
        >
          {state === "sending" ? "Sending…" : "Send feedback"}
        </button>
        {state === "sent" && (
          <span className="feedback-note">Thanks for the feedback!</span>
        )}
        {state === "error" && (
          <span className="feedback-note">
            Couldn't send — please try again.
          </span>
        )}
      </form>
    </main>
  );
}

export default Feedback;
