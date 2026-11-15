import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'

// Simple feedback box: posts the message to /api/feedback.
function FeedbackBox() {
  const [message, setMessage] = useState('')
  const [state, setState] = useState('idle') // idle | sending | sent | error

  async function submit(e) {
    e.preventDefault()
    if (!message.trim()) return
    setState('sending')
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      if (!res.ok) throw new Error()
      setMessage('')
      setState('sent')
    } catch {
      setState('error')
    }
  }

  return (
    <form className="feedback" onSubmit={submit}>
      <h2>Feedback</h2>
      <textarea
        value={message}
        onChange={(e) => {
          setMessage(e.target.value)
          setState('idle')
        }}
        maxLength={2000}
        rows={4}
        placeholder="Tell us what works, what doesn't, or what you'd like to see…"
      />
      <button className="add-button" disabled={!message.trim() || state === 'sending'}>
        {state === 'sending' ? 'Sending…' : 'Send feedback'}
      </button>
      {state === 'sent' && <span className="feedback-note">Thanks for the feedback!</span>}
      {state === 'error' && <span className="feedback-note">Couldn't send — please try again.</span>}
    </form>
  )
}

function Home({ books, onAdd, onAddTranslation }) {
  const originalRef = useRef(null)
  const translationRef = useRef(null)

  function handleOriginal(e) {
    const file = e.target.files[0]
    if (file) onAdd(file)
    e.target.value = ''
  }

  function handleTranslation(e) {
    const file = e.target.files[0]
    if (file) onAddTranslation(file)
    e.target.value = ''
  }

  return (
    <main className="page">
      <input
        ref={originalRef}
        type="file"
        accept=".epub"
        onChange={handleOriginal}
        hidden
      />
      <input
        ref={translationRef}
        type="file"
        accept=".epub"
        onChange={handleTranslation}
        hidden
      />
      <button className="add-button" onClick={() => originalRef.current.click()}>
        + Add ebook
      </button>
      <button
        className="add-button"
        onClick={() => translationRef.current.click()}
      >
        + Add translation
      </button>

      <ul className="book-list">
        {books.map((book) => (
          <li key={book.id}>
            <Link to={`/book/${book.id}`}>
              {book.name}
              {book.translationUrl && <span className="tag"> + translation</span>}
            </Link>
          </li>
        ))}
      </ul>

      <FeedbackBox />
    </main>
  )
}

export default Home
