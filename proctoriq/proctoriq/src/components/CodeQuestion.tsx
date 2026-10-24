import { useEffect, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { cpp } from '@codemirror/lang-cpp'
import { java } from '@codemirror/lang-java'
import { python } from '@codemirror/lang-python'
import { api } from '../api'
import type { CandidateQuestion, CodeAnswer, CodingLanguage } from '../types'

interface ExecutionResult {
  status: string
  stdout: string | null
  stderr: string | null
  compileOutput: string | null
  exitCode: number | null
}

interface TestResult extends ExecutionResult {
  passed: boolean
  index: number
  expectedOutput?: string
}

const languages: { id: CodingLanguage; label: string; extension: ReturnType<typeof python> }[] = [
  { id: 'python', label: 'Python 3', extension: python() },
  { id: 'cpp', label: 'C++17', extension: cpp() },
  { id: 'java', label: 'Java', extension: java() }
]

const defaultCode: Record<CodingLanguage, string> = {
  python: 'import sys\n\ndef solve():\n    data = sys.stdin.read()\n    # Parse the input and implement your solution.\n    pass\n\nif __name__ == "__main__":\n    solve()\n',
  cpp: '#include <iostream>\n#include <string>\nusing namespace std;\n\nint main() {\n    // Read input, implement your solution, and print the result.\n    return 0;\n}\n',
  java: 'import java.util.*;\n\npublic class prog {\n    public static void main(String[] args) {\n        // Read input, implement your solution, and print the result.\n    }\n}\n'
}

export default function CodeQuestion({ question, answer, onSave, attemptId, index, total }: {
  question: CandidateQuestion
  index: number
  total: number
  answer?: CodeAnswer
  onSave: (value: CodeAnswer) => void
  attemptId: string
}) {
  const [language, setLanguage] = useState<CodingLanguage>(answer?.language || 'python')
  const [source, setSource] = useState(answer?.source || defaultCode.python)
  const [stdin, setStdin] = useState('')
  const [execution, setExecution] = useState<ExecutionResult | null>(null)
  const [testResults, setTestResults] = useState<TestResult[] | null>(null)
  const [busy, setBusy] = useState<'run' | 'custom' | 'submit' | null>(null)
  const [error, setError] = useState('')
  const [draftStatus, setDraftStatus] = useState<'saving' | 'saved' | 'error'>('saved')
  const [testResultMode, setTestResultMode] = useState<'examples' | 'submission'>('examples')
  const currentDraft = useRef({ language, source })
  currentDraft.current = { language, source }

  useEffect(() => {
    const draft = currentDraft.current
    setDraftStatus('saving')
    const timer = window.setTimeout(() => {
      void api<{ saved: boolean }>(`/api/attempts/${encodeURIComponent(attemptId)}/code/save`, {
        method: 'POST',
        body: JSON.stringify({ questionId: question.id, ...draft })
      }).then(() => {
        if (currentDraft.current.language === draft.language && currentDraft.current.source === draft.source) {
          setDraftStatus('saved')
        }
      }).catch(() => {
        if (currentDraft.current.language === draft.language && currentDraft.current.source === draft.source) {
          setDraftStatus('error')
        }
      })
    }, 700)
    return () => window.clearTimeout(timer)
  }, [attemptId, question.id, language, source])

  const selectLanguage = (next: CodingLanguage) => {
    setLanguage(next)
    const nextSource = defaultCode[next]
    setSource(nextSource)
    onSave({ language: next, source: nextSource, submitted: answer?.submitted })
    setExecution(null)
    setTestResults(null)
  }

  const run = async () => {
    setBusy('run')
    setError('')
    setExecution(null)
    setTestResults(null)
    try {
      await api<{ saved: boolean }>(`/api/attempts/${encodeURIComponent(attemptId)}/code/save`, {
        method: 'POST',
        body: JSON.stringify({ questionId: question.id, language, source })
      })
      setDraftStatus('saved')
      const result = await api<{ mode: 'examples'; passed: number; total: number; results: TestResult[] }>(`/api/attempts/${encodeURIComponent(attemptId)}/code/run`, {
        method: 'POST',
        body: JSON.stringify({ questionId: question.id, language, source, mode: 'examples' })
      })
      setTestResultMode('examples')
      setTestResults(result.results)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not run code.')
    } finally {
      setBusy(null)
    }
  }

  const runCustomInput = async () => {
    setBusy('custom')
    setError('')
    setExecution(null)
    setTestResults(null)
    try {
      await api<{ saved: boolean }>(`/api/attempts/${encodeURIComponent(attemptId)}/code/save`, {
        method: 'POST',
        body: JSON.stringify({ questionId: question.id, language, source })
      })
      setDraftStatus('saved')
      const result = await api<{ result: ExecutionResult }>(`/api/attempts/${encodeURIComponent(attemptId)}/code/run`, {
        method: 'POST',
        body: JSON.stringify({ questionId: question.id, language, source, mode: 'custom', stdin })
      })
      setExecution(result.result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not run code with custom input.')
    } finally {
      setBusy(null)
    }
  }

  const submitCode = async () => {
    setBusy('submit')
    setError('')
    setTestResults(null)
    try {
      const result = await api<{ passed: number; total: number; score: number; results: TestResult[] }>(`/api/attempts/${encodeURIComponent(attemptId)}/code/submit`, {
        method: 'POST',
        body: JSON.stringify({ questionId: question.id, language, source })
      })
      setTestResultMode('submission')
      setTestResults(result.results)
      setDraftStatus('saved')
      onSave({
        language,
        source,
        submitted: { language, source, passed: result.passed, total: result.total, score: result.score }
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not submit code.')
    } finally {
      setBusy(null)
    }
  }

  const activeLanguage = languages.find(item => item.id === language)!
  const output = execution && (execution.compileOutput || execution.stderr || execution.stdout || execution.status)
  return (
    <section className="card" aria-labelledby="qtext">
      <p className="text-sm font-semibold text-ashley">Question {index + 1} of {total} · {question.category} · Coding</p>
      <h2 id="qtext" className="mt-2 text-xl font-bold">{question.text}</h2>
      {question.examples?.length ? <div className="mt-4 space-y-3">
        <h3 className="font-bold">Examples</h3>
        {question.examples.map((example, index) => <div key={index} className="rounded-md bg-gray-50 p-3 font-mono text-sm">
          <p><b>Input:</b><br /><pre className="whitespace-pre-wrap">{typeof example.input === 'string' ? example.input || '(empty)' : JSON.stringify(example.input, null, 2)}</pre></p>
          <p className="mt-2"><b>Output:</b><br /><pre className="whitespace-pre-wrap">{example.output}</pre></p>
        </div>)}
      </div> : null}
      {question.constraints && <div className="mt-4"><h3 className="font-bold">Constraints</h3><pre className="mt-1 whitespace-pre-wrap text-sm">{question.constraints}</pre></div>}
      <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <label htmlFor={`language-${question.id}`} className="block text-sm font-bold">Programming language</label>
          <select id={`language-${question.id}`} value={language} onChange={event => selectLanguage(event.target.value as CodingLanguage)} disabled={busy !== null}
            className="mt-1 rounded-md border-2 border-gray-300 p-2">
            {languages.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-secondary" onClick={() => void run()} disabled={busy !== null}>{busy === 'run' ? 'Running samples…' : 'Run Code'}</button>
          <button className="btn btn-secondary" onClick={() => void runCustomInput()} disabled={busy !== null}>{busy === 'custom' ? 'Running input…' : 'Run Custom Input'}</button>
          <button className="btn btn-primary" onClick={() => void submitCode()} disabled={busy !== null}>{busy === 'submit' ? 'Evaluating…' : 'Submit Code'}</button>
        </div>
      </div>
      <div className="mt-3 overflow-hidden rounded-md border border-gray-300">
        <CodeMirror value={source} height="320px" extensions={[activeLanguage.extension]} onChange={value => {
          setSource(value)
          onSave({ language, source: value, submitted: answer?.submitted })
          setDraftStatus('saving')
          setExecution(null)
          setTestResults(null)
        }} editable={!busy} basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }} />
      </div>
      <p className="mt-2 text-xs">Your code is saved automatically. Run Code compiles it and checks the public sample cases. Run Custom Input executes the code with your input below. Submit Code grades the private assessment test cases.</p>
      <p className="mt-1 text-xs" role="status" aria-live="polite">
        {draftStatus === 'saving' ? 'Saving code…' : draftStatus === 'saved' ? 'Code saved.' : 'Could not save code to the server. It remains saved in this browser; use Run Code to retry saving.'}
      </p>
      {answer?.submitted && (answer.submitted.language !== language || answer.submitted.source !== source) &&
        <p role="status" className="mt-2 text-sm font-semibold text-amber-700">Your code has changed since the last graded submission. Submit Code again to grade this version.</p>}
      <div className="mt-4">
        <label htmlFor={`stdin-${question.id}`} className="block text-sm font-bold">Custom input</label>
        <textarea id={`stdin-${question.id}`} value={stdin} onChange={event => setStdin(event.target.value)} rows={3} maxLength={20000}
          className="mt-1 w-full rounded-md border-2 border-gray-300 p-2 font-mono text-sm" />
      </div>
      {error && <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p>}
      {testResults && <div className="mt-4 rounded-md border border-gray-300 p-3" role="status">
        <h3 className="font-bold">{testResultMode === 'examples' ? 'Sample test results' : 'Submission result'}: {testResults.filter(result => result.passed).length} of {testResults.length} test cases passed</h3>
        <ul className="mt-2 space-y-2 text-sm">{testResults.map(result => <li key={result.index} className={`rounded p-2 ${result.passed ? 'bg-green-50' : 'bg-red-50'}`}>
          <b className={result.passed ? 'text-green-800' : 'text-red-800'}>Test case {result.index + 1}: {result.passed ? 'PASSED' : 'FAILED'}</b>
          {!result.passed && <p className="mt-1">Execution status: {result.status}</p>}
          {testResultMode === 'examples' && <pre className="mt-1 whitespace-pre-wrap">Expected: {result.expectedOutput ?? ''}</pre>}
          {result.compileOutput && <pre className="mt-1 whitespace-pre-wrap text-red-700">{result.compileOutput}</pre>}
          {result.stderr && <pre className="mt-1 whitespace-pre-wrap text-red-700">{result.stderr}</pre>}
          {result.stdout && <pre className="mt-1 whitespace-pre-wrap">Your output: {result.stdout}</pre>}
        </li>)}</ul>
      </div>}
      {execution && <div className="mt-4 rounded-md border border-gray-300 p-3" role="status">
        <h3 className="font-bold">Run result: {execution.status}</h3>
        {output && <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-sm">{execution.compileOutput || execution.stderr || execution.stdout || execution.status}</pre>}
      </div>}
    </section>
  )
}
