import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { api } from '../api'
import type { AdminQuestion, CodeExample, CodeTestCase, Result } from '../types'
import ConfirmDialog from './ConfirmDialog'

type AuthState = 'checking' | 'signed-out' | 'signed-in'
type Tab = 'results' | 'questions'

const csvCell = (value: string | number | boolean) => {
  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

export default function AdminDashboard() {
  const [auth, setAuth] = useState<AuthState>('checking')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [results, setResults] = useState<Result[]>([])
  const [questions, setQuestions] = useState<AdminQuestion[]>([])
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('time-desc')
  const [open, setOpen] = useState<Result | null>(null)
  const [clearResults, setClearResults] = useState(false)
  const [tab, setTab] = useState<Tab>('results')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [testCaseDrafts, setTestCaseDrafts] = useState<Record<string, string>>({})
  const [exampleDrafts, setExampleDrafts] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    const [resultResponse, questionResponse] = await Promise.all([
      api<{ results: Result[] }>('/api/admin/results'),
      api<{ questions: AdminQuestion[] }>('/api/admin/questions')
    ])
    setResults(resultResponse.results)
    setQuestions(questionResponse.questions)
  }, [])

  useEffect(() => {
    let cancelled = false
    api<{ authenticated: boolean; username: string | null }>('/api/admin/session')
      .then(async session => {
        if (cancelled) return
        if (!session.authenticated) {
          setAuth('signed-out')
          return
        }
        setUsername(session.username || '')
        setAuth('signed-in')
        try {
          await refresh()
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the administrator dashboard.')
        }
      })
      .catch(e => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Could not connect to the server.')
        setAuth('signed-out')
      })
    return () => { cancelled = true }
  }, [refresh])

  const rows = useMemo(() => {
    const filtered = results.filter(result => result.name.toLowerCase().includes(search.trim().toLowerCase()))
    const [key, direction] = sort.split('-')
    const multiplier = direction === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => key === 'score'
      ? (a.score - b.score) * multiplier
      : (Date.parse(a.submittedAt) - Date.parse(b.submittedAt)) * multiplier)
  }, [results, search, sort])

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const session = await api<{ username: string }>('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      })
      setPassword('')
      setUsername(session.username)
      setAuth('signed-in')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed.')
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    setError('')
    setBusy(true)
    try {
      await api('/api/admin/logout', { method: 'POST', body: '{}' })
      setResults([])
      setQuestions([])
      setAuth('signed-out')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign out.')
    } finally {
      setBusy(false)
    }
  }

  const saveQuestions = async () => {
    setError('')
    setNotice('')
    setBusy(true)
    try {
      const response = await api<{ questions: AdminQuestion[] }>('/api/admin/questions', {
        method: 'PUT',
        body: JSON.stringify({
          questions: questions.map(question => ({
            ...question,
            ...(question.kind === 'coding' ? {
              testCases: JSON.parse(testCaseDrafts[question.id] ?? JSON.stringify(question.testCases ?? [])) as CodeTestCase[],
              examples: JSON.parse(exampleDrafts[question.id] ?? JSON.stringify(question.examples ?? [])) as CodeExample[]
            } : {})
          }))
        })
      })
      setQuestions(response.questions)
      setNotice('Question bank saved. New attempts will use these questions.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save questions.')
    } finally {
      setBusy(false)
    }
  }

  const deleteResults = async () => {
    setError('')
    setBusy(true)
    try {
      await api('/api/admin/results', { method: 'DELETE', body: '{}' })
      setResults([])
      setOpen(null)
      setClearResults(false)
      setNotice('Completed results were deleted.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete results.')
    } finally {
      setBusy(false)
    }
  }

  const exportCsv = () => {
    const headers = ['Attempt ID', 'Candidate', 'Started', 'Submitted', 'MCQ score', 'MCQ total', 'Coding tests passed', 'Coding tests total', 'Overall score', 'Overall total', 'Percentage', 'Tab switches', 'Full-screen exits', 'Webcam events', 'Auto submitted']
    const data = rows.map(result => [result.id, result.name, result.startedAt, result.submittedAt, result.mcqScore ?? '', result.mcqTotal ?? '', result.codingScore ?? '', result.codingTotal ?? '', result.score, result.total, result.percentage, result.tabSwitchCount, result.fullscreenExitCount || 0, result.webcamEventCount, result.autoSubmitted])
    const content = [headers, ...data].map(row => row.map(csvCell).join(',')).join('\r\n')
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'proctoriq-results.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  const updateQuestion = (index: number, update: Partial<AdminQuestion>) => {
    setQuestions(current => current.map((question, i) => i === index ? { ...question, ...update } : question))
    setNotice('')
  }
  const addQuestion = () => {
    const question: AdminQuestion = {
      id: `q-${crypto.randomUUID()}`,
      category: 'General',
      text: '',
      options: ['', ''],
      answer: 0,
      kind: 'mcq'
    }
    setQuestions(current => [...current, question])
    setNotice('')
  }
  const removeQuestion = (index: number) => {
    setQuestions(current => current.filter((_, i) => i !== index))
    setNotice('')
  }
  const formatTime = (value: string) => new Date(value).toLocaleString()

  if (auth === 'checking') {
    return <main className="mx-auto max-w-xl px-6 py-16 text-center" role="status">Checking administrator session…</main>
  }

  if (auth === 'signed-out') {
    return (
      <main className="mx-auto max-w-md px-6 py-12">
        <img src="/ashley-logo.jpeg" alt="Ashley Furniture India Pvt. Ltd." className="mx-auto h-auto w-full max-w-[240px] object-contain" />
        <h1 className="mt-8 text-3xl font-extrabold">Administrator sign-in</h1>
        <p className="mt-2 text-sm">This area is restricted to authorized administrators.</p>
        {error && <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p>}
        <form className="mt-6 space-y-4" onSubmit={event => void login(event)}>
          <div>
            <label htmlFor="admin-username" className="block font-bold">Username</label>
            <input id="admin-username" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required maxLength={80}
              className="mt-1 w-full rounded-md border-2 border-gray-300 p-3" />
          </div>
          <div>
            <label htmlFor="admin-password" className="block font-bold">Password</label>
            <input id="admin-password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required
              className="mt-1 w-full rounded-md border-2 border-gray-300 p-3" />
          </div>
          <button className="btn btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <a href="#/" className="mt-5 inline-block text-sm text-charcoal underline">Back to home</a>
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-3xl font-extrabold">Admin dashboard</h1><p className="mt-1 text-sm">Signed in as {username}</p></div>
        <div className="flex gap-2">
          <a className="btn btn-secondary" href="#/">Home</a>
          <button className="btn btn-secondary" onClick={() => void logout()} disabled={busy}>Sign out</button>
        </div>
      </header>
      {error && <p role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p>}
      {notice && <p role="status" className="mt-4 rounded-md bg-green-50 p-3 text-sm font-semibold text-green-800">{notice}</p>}

      <nav className="mt-6 flex gap-2 border-b border-gray-200" aria-label="Admin sections">
        <button className={`border-b-2 px-4 py-2 font-bold ${tab === 'results' ? 'border-ashley text-ashley' : 'border-transparent'}`} onClick={() => setTab('results')}>Results & warnings</button>
        <button className={`border-b-2 px-4 py-2 font-bold ${tab === 'questions' ? 'border-ashley text-ashley' : 'border-transparent'}`} onClick={() => setTab('questions')}>Questions</button>
      </nav>

      {tab === 'results' ? (
        <section className="pt-5">
          <p className="font-bold">Total completed attempts: {results.length}</p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div><label htmlFor="candidate-search" className="block text-sm font-bold">Search by name</label><input id="candidate-search" value={search} onChange={event => setSearch(event.target.value)} className="rounded-md border-2 border-gray-300 p-2" /></div>
            <div><label htmlFor="sort-results" className="block text-sm font-bold">Sort</label>
              <select id="sort-results" value={sort} onChange={event => setSort(event.target.value)} className="rounded-md border-2 border-gray-300 p-2">
                <option value="time-desc">Newest first</option><option value="time-asc">Oldest first</option>
                <option value="score-desc">Highest score</option><option value="score-asc">Lowest score</option>
              </select>
            </div>
            <button className="btn btn-primary" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
            <button className="btn btn-secondary" onClick={() => void refresh()} disabled={busy}>Refresh</button>
            <button className="btn btn-secondary" onClick={() => setClearResults(true)} disabled={!results.length || busy}>Clear all results</button>
          </div>
          {rows.length === 0 ? <p className="card mt-6 text-center">No completed attempts to show yet.</p> : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[1050px] border-collapse text-left text-sm">
                <thead><tr className="border-b-2 border-charcoal">{['Candidate', 'MCQ score', 'Coding tests', 'Overall', '%', 'Submitted', 'Tab switches', 'Full-screen exits', 'Webcam events', ''].map(heading => <th key={heading} className="p-2">{heading}</th>)}</tr></thead>
                <tbody>{rows.map(result => (
                  <tr key={result.id} className="border-b border-gray-200">
                    <td className="p-2 font-semibold">{result.name}</td>
                    <td className="p-2">{result.mcqScore === undefined ? 'Not recorded' : `${result.mcqScore}/${result.mcqTotal ?? 0}`}</td>
                    <td className="p-2">{result.codingScore === undefined ? 'Not recorded' : `${result.codingScore}/${result.codingTotal ?? 0} tests`}</td>
                    <td className="p-2">{result.score}/{result.total}</td><td className="p-2">{result.percentage}%</td>
                    <td className="p-2">{formatTime(result.submittedAt)}</td><td className="p-2">{result.tabSwitchCount}</td><td className="p-2">{result.fullscreenExitCount || 0}</td><td className="p-2">{result.webcamEventCount}</td>
                    <td className="p-2"><button className="font-bold text-ashley underline" onClick={() => setOpen(result)}>View warnings</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <section className="pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">Edits apply to new attempts. Active and completed attempts keep their original question set.</p>
            <div className="flex gap-2"><button className="btn btn-secondary" onClick={addQuestion}>Add question</button><button className="btn btn-primary" onClick={() => void saveQuestions()} disabled={busy}>{busy ? 'Saving…' : 'Save questions'}</button></div>
          </div>
          {questions.length === 0 && <p className="card mt-5">No questions in the question bank. Add a question to begin.</p>}
          <div className="mt-4 space-y-4">
            {questions.map((question, index) => (
              <article key={question.id} className="card">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-bold">Question {index + 1}</h2>
                  <button className="text-sm font-bold text-red-700 underline" onClick={() => removeQuestion(index)}>Remove</button>
                </div>
                <div className="mt-3">
                  <label htmlFor={`kind-${question.id}`} className="block text-sm font-bold">Question type</label>
                  <select id={`kind-${question.id}`} value={question.kind || 'mcq'} onChange={event => {
                    const kind = event.target.value as 'mcq' | 'coding'
                    updateQuestion(index, kind === 'coding'
                      ? { kind, options: [], answer: undefined, constraints: '', examples: [], testCases: [] }
                      : { kind, options: question.options.length ? question.options : ['', ''], answer: question.answer ?? 0 })
                  }} className="mt-1 rounded-md border-2 border-gray-300 p-2">
                    <option value="mcq">Multiple choice</option><option value="coding">Coding</option>
                  </select>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <label htmlFor={`category-${question.id}`} className="block text-sm font-bold">Category</label>
                    <input id={`category-${question.id}`} value={question.category} onChange={event => updateQuestion(index, { category: event.target.value })} maxLength={100}
                      className="mt-1 w-full rounded-md border-2 border-gray-300 p-2" />
                  </div>
                  <div>
                    <label htmlFor={`text-${question.id}`} className="block text-sm font-bold">{question.kind === 'coding' ? 'Problem statement' : 'Question'}</label>
                    <textarea id={`text-${question.id}`} value={question.text} onChange={event => updateQuestion(index, { text: event.target.value })} rows={2} maxLength={question.kind === 'coding' ? 20000 : 2000}
                      className="mt-1 w-full rounded-md border-2 border-gray-300 p-2" />
                  </div>
                  {(question.kind || 'mcq') === 'mcq' && <div>
                    <label htmlFor={`options-${question.id}`} className="block text-sm font-bold">Answer options (one per line; 2-8)</label>
                    <textarea id={`options-${question.id}`} value={question.options.join('\n')} onChange={event => updateQuestion(index, { options: event.target.value.split('\n') })} rows={4}
                      className="mt-1 w-full rounded-md border-2 border-gray-300 p-2" />
                  </div>}
                  {(question.kind || 'mcq') === 'mcq' && <div>
                    <label htmlFor={`answer-${question.id}`} className="block text-sm font-bold">Correct answer</label>
                    <select id={`answer-${question.id}`} value={question.answer} onChange={event => updateQuestion(index, { answer: Number(event.target.value) })}
                      className="mt-1 w-full rounded-md border-2 border-gray-300 p-2">
                      {question.options.map((option, optionIndex) => <option key={optionIndex} value={optionIndex}>Option {optionIndex + 1}: {option || '(empty)'}</option>)}
                    </select>
                  </div>}
                  {question.kind === 'coding' && <>
                    <div>
                      <label htmlFor={`constraints-${question.id}`} className="block text-sm font-bold">Constraints</label>
                      <textarea id={`constraints-${question.id}`} value={question.constraints || ''} onChange={event => updateQuestion(index, { constraints: event.target.value })} rows={3} maxLength={10000}
                        className="mt-1 w-full rounded-md border-2 border-gray-300 p-2" />
                    </div>
                    <div>
                      <label htmlFor={`examples-${question.id}`} className="block text-sm font-bold">Public examples (JSON array of input/output pairs)</label>
                      <textarea id={`examples-${question.id}`} value={exampleDrafts[question.id] ?? JSON.stringify(question.examples ?? [], null, 2)} onChange={event => setExampleDrafts(current => ({ ...current, [question.id]: event.target.value }))} rows={5}
                        className="mt-1 w-full rounded-md border-2 border-gray-300 p-2 font-mono text-sm" />
                    </div>
                    <div className="md:col-span-2">
                      <label htmlFor={`test-cases-${question.id}`} className="block text-sm font-bold">Private grading test cases (JSON array of input/expectedOutput pairs)</label>
                      <textarea id={`test-cases-${question.id}`} value={testCaseDrafts[question.id] ?? JSON.stringify(question.testCases ?? [], null, 2)} onChange={event => setTestCaseDrafts(current => ({ ...current, [question.id]: event.target.value }))} rows={6}
                        className="mt-1 w-full rounded-md border-2 border-gray-300 p-2 font-mono text-sm" />
                      <p className="mt-1 text-xs">Hidden test cases are stored on the server and are not sent to candidates.</p>
                    </div>
                  </>}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Attempt warnings">
          <div className="card max-h-[85vh] w-full max-w-lg overflow-y-auto">
            <h2 className="text-xl font-bold">{open.name}</h2>
            <p className="text-sm">Attempt {open.id}<br />Started {formatTime(open.startedAt)} · Submitted {formatTime(open.submittedAt)}{open.autoSubmitted && ' (auto-submitted)'}</p>
            <h3 className="mt-4 font-bold">Score breakdown</h3>
            {open.mcqScore === undefined
              ? <p className="mt-1 text-sm">Section scores were not recorded for this attempt. Overall score: {open.score}/{open.total} ({open.percentage}%).</p>
              : <ul className="mt-1 space-y-1 text-sm">
                <li>Multiple-choice: <b>{open.mcqScore}/{open.mcqTotal ?? 0}</b></li>
                <li>Coding tests passed: <b>{open.codingScore ?? 0}/{open.codingTotal ?? 0}</b></li>
                <li>Overall: <b>{open.score}/{open.total}</b> ({open.percentage}%)</li>
              </ul>}
            <h3 className="mt-4 font-bold">Monitoring events ({open.events.length})</h3>
            {open.events.length === 0 ? <p className="text-sm">No events recorded.</p> :
              <ul className="mt-2 space-y-2 text-sm">{open.events.map((event, index) => <li key={index} className="rounded bg-gray-100 p-2"><b>{event.type.replace(/_/g, ' ')}</b> · {formatTime(event.at)}<br />{event.detail}</li>)}</ul>}
            {open.codingSubmissions && Object.entries(open.codingSubmissions).length > 0 && <>
              <h3 className="mt-4 font-bold">Coding submissions</h3>
              <div className="mt-2 space-y-2">{Object.entries(open.codingSubmissions).map(([questionId, submission]) => (
                <details key={questionId} className="rounded bg-gray-100 p-2">
                  <summary className="cursor-pointer font-semibold">{questionId} · {submission.passed}/{submission.total} tests · {submission.language}</summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{submission.source}</pre>
                </details>
              ))}</div>
            </>}
            <button className="btn btn-primary mt-4" onClick={() => setOpen(null)}>Close</button>
          </div>
        </div>
      )}
      {clearResults && <ConfirmDialog title="Clear all results?" body="This permanently deletes every completed result and its recorded monitoring events from the server."
        confirmLabel={busy ? 'Deleting…' : 'Delete all'} onCancel={() => setClearResults(false)} onConfirm={() => void deleteResults()} />}
    </main>
  )
}
