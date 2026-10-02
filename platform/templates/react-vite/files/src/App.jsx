import { useState } from 'react'

// Set VITE_API_URL in the dashboard (Env) to point at a deployed API, e.g. your Express repo.
const API_URL = import.meta.env.VITE_API_URL

export default function App() {
  const [count, setCount] = useState(0)
  const [items, setItems] = useState(null)
  const [error, setError] = useState(null)

  async function load() {
    setError(null)
    try {
      const res = await fetch(`${API_URL}/api/items`)
      setItems(await res.json())
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <main>
      <h1>__WS_APP_NAME__</h1>
      <p>React production build, deployed with <code>git push</code>. Edit <code>src/App.jsx</code>.</p>
      <button onClick={() => setCount((c) => c + 1)}>Clicked {count} times</button>
      <section>
        <h2>API</h2>
        {API_URL ? (
          <>
            <button onClick={load}>Load items from {API_URL}</button>
            {error && <p className="error">{error}</p>}
            {items && <pre>{JSON.stringify(items, null, 2)}</pre>}
          </>
        ) : (
          <p>Set <code>VITE_API_URL</code> in the dashboard and redeploy to call an API.</p>
        )}
      </section>
    </main>
  )
}
