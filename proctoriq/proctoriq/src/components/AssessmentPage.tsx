import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { go } from '../App'
import { api } from '../api'
import { consumeFullscreenStart } from '../fullscreen'
import { DURATION_MS, type Attempt, type EventType } from '../types'
import { clearActive, loadActive, saveActive } from '../storage'
import CountdownTimer from './CountdownTimer'
import QuestionCard from './QuestionCard'
import WebcamMonitor from './WebcamMonitor'
import ConfirmDialog from './ConfirmDialog'

const CodeQuestion = lazy(() => import('./CodeQuestion'))

const MSG: Record<EventType, string> = {
  tab_switch: 'You left the assessment window. This has been logged.',
  fullscreen_exit: 'You exited full-screen mode. This has been logged.',
  no_face: 'No face has been visible for several seconds. Please stay in front of the camera.',
  multiple_faces: 'More than one face is visible. Only the candidate should be in view.',
  camera_unavailable: 'Camera unavailable. Face monitoring is not active.',
  detector_unavailable: 'Face detection unavailable. The assessment can continue without it.'
}

export default function AssessmentPage() {
  const [attempt, setAttempt] = useState<Attempt | null>(() => loadActive())
  const ref = useRef(attempt); ref.current = attempt
  const [idx, setIdx] = useState(0)
  const [warning, setWarning] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(() => Boolean(document.fullscreenElement))
  const done = useRef(false)

  useEffect(() => { if (!attempt) go('/instructions') }, [attempt])

  const update = useCallback((fn: (a: Attempt) => Attempt) => {
    const current = ref.current
    if (!current || done.current) return
    const next = fn(current)
    ref.current = next
    setAttempt(next)
    try {
      saveActive(next)
    } catch {
      setWarning('Your latest activity could not be saved on this device. Keep this tab open until submission completes.')
    }
  }, [])
  const addEvent = useCallback((type: EventType, detail: string) => {
    update(a => ({ ...a, events: [...a.events, { type, detail, at: new Date().toISOString() }] }))
    setWarning(MSG[type])
  }, [update])

  const submit = useCallback(async (auto: boolean) => {
    const a = ref.current
    if (done.current || !a) return
    done.current = true
    setSubmitting(true)
    try {
      await api<{ id: string }>(`/api/attempts/${encodeURIComponent(a.id)}/submit`, {
        method: 'POST',
        body: JSON.stringify({ answers: a.answers, events: a.events, autoSubmitted: auto })
      })
      try {
        clearActive()
      } catch {
        setWarning('Your submission was received, but this device could not clear the saved attempt.')
      }
      go(`/results/${encodeURIComponent(a.id)}`)
    } catch (e) {
      done.current = false
      setSubmitting(false)
      setConfirm(false)
      setWarning(e instanceof Error ? `Submission failed: ${e.message} Please try again.` : 'Submission failed. Please try again.')
    }
  }, [])

  useEffect(() => {
    if (!attempt) return
    const startState = consumeFullscreenStart()
    let wasEntered = Boolean(document.fullscreenElement) || startState === 'entered'
    if (startState === 'unavailable') setWarning('Full-screen mode could not be enabled in this browser. The assessment can continue in a normal window.')
    setIsFullscreen(Boolean(document.fullscreenElement))
    if (wasEntered && !document.fullscreenElement) addEvent('fullscreen_exit', 'Candidate exited browser full-screen mode')
    const changed = () => {
      const active = Boolean(document.fullscreenElement)
      setIsFullscreen(active)
      if (active) wasEntered = true
      else if (wasEntered) {
        wasEntered = false
        addEvent('fullscreen_exit', 'Candidate exited browser full-screen mode')
      }
    }
    document.addEventListener('fullscreenchange', changed)
    return () => document.removeEventListener('fullscreenchange', changed)
  }, [!!attempt, addEvent])

  const enterFullscreen = async () => {
    if (!document.documentElement.requestFullscreen) {
      setWarning('This browser does not support full-screen mode. The assessment can continue in a normal window.')
      return
    }
    try {
      await document.documentElement.requestFullscreen()
      setIsFullscreen(true)
    } catch {
      setWarning('The browser did not allow full-screen mode. The assessment can continue in a normal window.')
    }
  }

  // Tab-switch monitoring: one "away" flag prevents double-counting visibilitychange + blur.
  useEffect(() => {
    if (!attempt) return
    let away = false
    const leave = () => { if (away) return; away = true; addEvent('tab_switch', 'Candidate left the assessment tab or window') }
    const back = () => { if (away && document.visibilityState === 'visible') { away = false } }
    const vis = () => (document.visibilityState === 'hidden' ? leave() : back())
    document.addEventListener('visibilitychange', vis)
    window.addEventListener('blur', leave)
    window.addEventListener('focus', back)
    return () => { document.removeEventListener('visibilitychange', vis); window.removeEventListener('blur', leave); window.removeEventListener('focus', back) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!attempt, addEvent])

  if (!attempt) return null
  const deadline = attempt.startedAt + DURATION_MS
  const q = attempt.questions[idx]
  if (!q) return <main className="mx-auto max-w-xl px-6 py-16 text-center"><p role="alert">This saved attempt is invalid. Please contact an administrator.</p></main>
  const mcqIndices = attempt.questions.flatMap((question, index) => question.kind === 'coding' ? [] : [index])
  const codingIndices = attempt.questions.flatMap((question, index) => question.kind === 'coding' ? [index] : [])
  const sectionIndices = q.kind === 'coding' ? codingIndices : mcqIndices
  const sectionQuestionNumber = sectionIndices.indexOf(idx) + 1
  const sectionName = q.kind === 'coding' ? 'Coding questions' : 'Multiple-choice questions'
  const sectionNumber = q.kind === 'coding' && mcqIndices.length > 0 ? 2 : 1
  const answered = attempt.questions.filter(question => attempt.answers[question.id] !== undefined ||
    Boolean(attempt.codeAnswers?.[question.id]?.source.trim())).length
  const unanswered = attempt.questions.length - answered

  return (
    <main className="assessment-shell mx-auto max-w-6xl px-4 py-4">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 pb-3">
        <div><p className="font-bold">ProctorIQ · {attempt.name}</p><p className="text-sm">{answered} of {attempt.questions.length} answered</p></div>
        <div className="flex items-center gap-2">
          {!isFullscreen && <button className="btn btn-secondary" onClick={() => void enterFullscreen()} disabled={submitting}>Enter full screen</button>}
          <CountdownTimer deadline={deadline} onExpire={() => void submit(true)} />
        </div>
      </header>
      {warning && (
        <div role="alert" className="mt-3 flex items-start justify-between gap-3 rounded-md border-2 border-amber-500 bg-amber-50 p-3 font-semibold">
          <span>{warning}</span><button className="underline" onClick={() => setWarning('')}>Dismiss</button>
        </div>
      )}
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_280px]">
        <div>
          <section className="mb-4 rounded-lg border-l-4 border-ashley bg-gray-50 p-4" aria-label={sectionName}>
            <p className="text-xs font-bold uppercase tracking-wide text-ashley">Section {sectionNumber}</p>
            <h2 className="mt-1 text-lg font-extrabold">{sectionName}</h2>
            <p className="mt-1 text-sm">Question {sectionQuestionNumber} of {sectionIndices.length}</p>
          </section>
          {q.kind === 'coding'
            ? <Suspense fallback={<div className="card" role="status">Loading code editor…</div>}>
              <CodeQuestion key={q.id} question={q} index={sectionQuestionNumber - 1} total={sectionIndices.length} attemptId={attempt.id} answer={attempt.codeAnswers?.[q.id]}
                onSave={answer => update(a => ({ ...a, codeAnswers: { ...a.codeAnswers, [q.id]: answer } }))} />
            </Suspense>
            : <QuestionCard q={q} index={sectionQuestionNumber - 1} total={sectionIndices.length} selected={attempt.answers[q.id]}
              onSelect={i => update(a => ({ ...a, answers: { ...a.answers, [q.id]: i } }))} />}
          <div className="mt-4 flex flex-wrap justify-between gap-3">
            <button className="btn btn-secondary" disabled={idx === 0 || submitting} onClick={() => setIdx(idx - 1)}>Previous</button>
            {idx < attempt.questions.length - 1
              ? <button className="btn btn-primary" onClick={() => setIdx(idx + 1)}>Next</button>
              : <button className="btn btn-primary" onClick={() => setConfirm(true)} disabled={submitting}>Submit assessment</button>}
          </div>
        </div>
        <aside className="space-y-4">
          {attempt.cameraRequested
            ? <WebcamMonitor onEvent={addEvent} />
            : <div className="card text-sm font-semibold text-red-600">Camera monitoring is not active for this attempt.</div>}
          <nav className="card" aria-label="Question navigation">
            <p className="mb-2 font-bold">Assessment sections</p>
            {[
              { name: 'Multiple-choice questions', indices: mcqIndices },
              { name: 'Coding questions', indices: codingIndices }
            ].filter(section => section.indices.length > 0).map(section => (
              <div key={section.name} className="mt-3 first:mt-0">
                <h3 className="mb-2 text-sm font-bold">{section.name} ({section.indices.length})</h3>
                <div className="grid grid-cols-5 gap-2">
                  {section.indices.map((questionIndex, sectionIndex) => {
                    const question = attempt.questions[questionIndex]
                    const id = question.id
                    const isAnswered = attempt.answers[id] !== undefined || Boolean(attempt.codeAnswers?.[id]?.source.trim())
                    return <button key={id} onClick={() => setIdx(questionIndex)} disabled={submitting}
                      aria-label={`${section.name}, question ${sectionIndex + 1}, ${isAnswered ? 'answered' : 'unanswered'}`} aria-current={questionIndex === idx}
                      className={`h-10 rounded-md border-2 font-bold ${questionIndex === idx ? 'border-charcoal' : 'border-transparent'} ${isAnswered ? 'bg-ashley text-white' : 'bg-gray-100'}`}>{sectionIndex + 1}</button>
                  })}
                </div>
              </div>
            ))}
            <p className="mt-3 rounded bg-gray-50 p-2 text-xs font-semibold" role="status">Current section: {sectionName} · Question {sectionQuestionNumber} of {sectionIndices.length}</p>
            <p className="mt-2 text-xs"><span className="font-bold text-ashley">Orange</span> = answered, grey = unanswered</p>
            <button className="btn btn-secondary mt-3 w-full" onClick={() => setConfirm(true)} disabled={submitting}>Submit</button>
          </nav>
        </aside>
      </div>
      {confirm && <ConfirmDialog title="Submit assessment?" confirmLabel="Submit now"
        body={unanswered ? `You have ${unanswered} unanswered question${unanswered > 1 ? 's' : ''}. You cannot change answers after submitting.` : 'You cannot change answers after submitting.'}
        onCancel={() => setConfirm(false)} onConfirm={() => void submit(false)} />}
    </main>
  )
}
