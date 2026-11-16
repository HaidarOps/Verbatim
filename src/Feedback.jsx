import { useState } from "react";
import { Link } from "react-router-dom";

// Simple feedback box: posts the message to /api/feedback.
function Feedback() {
  const [message, setMessage] = useState("");
  const [state, setState] = useState("idle"); // idle | sending | sent | error

  async function submit(e) {
    e.preventDefault();
    if (!message.trim()) return;
    setState("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
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
