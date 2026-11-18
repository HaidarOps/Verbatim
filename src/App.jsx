import { useState } from 'react'
import { Routes, Route } from 'react-router-dom'
import Home from './Home.jsx'
import Feedback from './Feedback.jsx'
import Reader from './Reader.jsx'
import ZoomHandles from './ZoomHandles.jsx'

// Books bundled in public/books, always available on the main menu.
const BASE = import.meta.env.BASE_URL
const BUNDLED_BOOKS = [
  {
    id: 'candide',
    name: 'Candide (English / French)',
    url: `${BASE}books/candide_en.epub`,
    translationUrl: `${BASE}books/candide_fr.epub`,
  },
  {
    id: 'around-the-world',
    name: 'Around the World in Eighty Days (French / English)',
    url: `${BASE}books/around_the_world_fr.epub`,
    translationUrl: `${BASE}books/around_the_world_en.epub`,
    englishSide: 'translation',
  },
]

function App() {
  const [books, setBooks] = useState(BUNDLED_BOOKS)

  function addBook(file) {
    const book = {
      id: crypto.randomUUID(),
      name: file.name,
      url: URL.createObjectURL(file),
    }
    setBooks((prev) => [...prev, book])
  }

  // Attach a translation to the most recently added book so it can be read
  // side by side with the original. If there are no books yet, start one.
  function addTranslation(file) {
    const translationUrl = URL.createObjectURL(file)
    setBooks((prev) => {
      if (prev.length === 0) {
        return [{ id: crypto.randomUUID(), name: file.name, url: translationUrl }]
      }
      const next = [...prev]
      const last = next[next.length - 1]
      next[next.length - 1] = { ...last, translationUrl }
      return next
    })
  }

  return (
    <>
      <ZoomHandles />
      <Routes>
        <Route
          path="/"
          element={
            <Home
              books={books}
              onAdd={addBook}
              onAddTranslation={addTranslation}
            />
          }
        />
        <Route path="/feedback" element={<Feedback />} />
        <Route path="/book/:id" element={<Reader books={books} />} />
      </Routes>
    </>
  )
}

export default App
