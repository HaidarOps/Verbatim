import { useRef } from 'react'
import { Link } from 'react-router-dom'
import GettingStarted from './GettingStarted.jsx'

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

      <Link className="feedback-button" to="/feedback">
        Feedback
      </Link>
      <GettingStarted className="guide-button" />

    </main>
  )
}

export default Home
