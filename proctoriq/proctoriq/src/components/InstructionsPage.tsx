import { useState } from 'react'
import { go } from '../App'
import { api } from '../api'
import { loadActive, saveActive } from '../storage'
import { setFullscreenStart } from '../fullscreen'
import type { Attempt } from '../types'

type Cam = 'idle' | 'checking' | 'ok' | 'error'
export default function InstructionsPage() {
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const [cam, setCam] = useState<Cam>('idle')
  const [camMsg, setCamMsg] = useState('')
  const [starting, setStarting] = useState(false)
  const active = loadActive()

  const checkCamera = async () => {
    setCam('checking'); setCamMsg('')
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      s.getTracks().forEach(t => t.stop()); setCam('ok')
    } catch (e) {
      setCam('error'); setCamMsg(`Camera access failed (${(e as Error).name || 'error'}). Allow camera access in your browser settings and try again.`)
    }
  }
  const start = async (withCamera: boolean) => {
    if (!name.trim()) { setErr('Please enter your full name before starting.'); return }
    setErr('')
    setStarting(true)
    const fullScreen = document.documentElement.requestFullscreen
      ? document.documentElement.requestFullscreen()
        .then(() => { setFullscreenStart('entered') })
        .catch(() => { setFullscreenStart('unavailable') })
      : Promise.resolve().then(() => { setFullscreenStart('unavailable') })
    try {
      const created = await api<Omit<Attempt, 'answers' | 'events' | 'cameraRequested'>>('/api/attempts', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() })
      })
      await fullScreen
      const attempt: Attempt = {
        ...created,
        answers: {},
        events: withCamera ? [] : [{
          type: 'camera_unavailable',
          at: new Date().toISOString(),
          detail: 'Candidate chose to continue without camera monitoring'
        }],
        cameraRequested: withCamera
      }
      saveActive(attempt)
      go('/assessment')
    } catch (e) {
      await fullScreen
      if (document.fullscreenElement && document.exitFullscreen) {
        try {
          await document.exitFullscreen()
        } catch {
          setErr('Could not start the assessment, and the browser could not exit full-screen mode. Press Esc to leave full-screen mode.')
          setStarting(false)
          return
        }
      }
      setErr(e instanceof Error ? e.message : 'Could not start the assessment. Please try again.')
      setStarting(false)
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <img src="/ashley-logo.jpeg" alt="Ashley Furniture India Pvt. Ltd." className="mx-auto h-auto w-full max-w-[260px] object-contain" />
      <h1 className="mt-8 text-3xl font-extrabold">Before you begin</h1>
      {active && <div className="card mt-4 border-ashley">An attempt by <b>{active.name}</b> is still in progress. <a className="font-bold text-ashley underline" href="#/assessment">Resume it</a>. Its original deadline still applies.</div>}
      <ul className="mt-6 list-disc space-y-2 pl-5">
        <li>Duration: <b>10 minutes</b>. The timer starts when you press Start Assessment and keeps running if you refresh.</li>
        <li>The question count and question types are set by the assessment administrator. Answer all questions.</li>
        <li>Your webcam is used to check that one face is visible. Video is processed in your browser and is never recorded or uploaded.</li>
        <li>Switching tabs or windows may be logged and shown to evaluators.</li>
        <li>The assessment will request browser full-screen mode when started. You can exit it; exiting may be logged. Full-screen mode does not prevent cheating.</li>
        <li>Browser monitoring cannot detect every form of cheating, and no event alone disqualifies a candidate.</li>
      </ul>
      <div className="mt-8">
        <label htmlFor="name" className="block font-bold">Full name</label>
        <input id="name" value={name} onChange={e => setName(e.target.value)} maxLength={80} autoComplete="name" aria-invalid={!!err} aria-describedby="name-err"
          className="mt-1 w-full rounded-md border-2 border-gray-300 p-3 focus:border-ashley" />
        <p id="name-err" role="alert" className="mt-1 text-sm text-red-600">{err}</p>
      </div>
      <div className="card mt-4">
        <h2 className="font-bold">Camera check</h2>
        {cam === 'ok' && <p className="mt-2 font-semibold text-green-700">Camera is ready.</p>}
        {cam === 'checking' && <p className="mt-2">Waiting for camera permission…</p>}
        {cam === 'error' && <p role="alert" className="mt-2 text-red-600">{camMsg} Without a camera, face monitoring is <b>not active</b>; this is recorded in your attempt.</p>}
        {cam !== 'ok' && <button className="btn btn-secondary mt-3" onClick={checkCamera} disabled={cam === 'checking'}>{cam === 'error' ? 'Try again' : 'Check camera'}</button>}
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <button className="btn btn-primary" onClick={() => void start(true)} disabled={cam !== 'ok' || starting}>{starting ? 'Starting…' : 'Start Assessment'}</button>
        {cam === 'error' && <button className="btn btn-secondary" onClick={() => void start(false)} disabled={starting}>Start without camera monitoring</button>}
        <a className="btn btn-secondary" href="#/">Back</a>
      </div>
    </main>
  )
}
