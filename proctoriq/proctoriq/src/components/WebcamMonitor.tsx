import { useEffect, useRef, useState } from 'react'
import type { EventType } from '../types'

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
const NO_FACE_MS = 5000, MULTI_MS = 3000, COOLDOWN_MS = 30000

type Status = 'starting' | 'one' | 'none' | 'multiple' | 'camera_error' | 'detector_unavailable'
const LABEL: Record<Status, { t: string; c: string }> = {
  starting: { t: 'Starting camera…', c: 'bg-gray-500' },
  one: { t: 'Monitoring: 1 face detected', c: 'bg-green-600' },
  none: { t: 'No face detected', c: 'bg-red-600' },
  multiple: { t: 'Multiple faces detected', c: 'bg-red-600' },
  camera_error: { t: 'Camera unavailable: not monitored', c: 'bg-red-600' },
  detector_unavailable: { t: 'Face detection unavailable', c: 'bg-amber-600' }
}

export default function WebcamMonitor({ onEvent }: { onEvent: (type: EventType, detail: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const cb = useRef(onEvent); cb.current = onEvent
  const [status, setStatus] = useState<Status>('starting')

  useEffect(() => {
    let cancelled = false, timer: number | undefined
    let stream: MediaStream | null = null
    let detector: { detectForVideo: (v: HTMLVideoElement, t: number) => { detections: unknown[] }; close?: () => void } | null = null
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: false })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        const v = videoRef.current!; v.srcObject = stream; await v.play().catch(() => {})
      } catch (e) {
        if (cancelled) return
        setStatus('camera_error'); cb.current('camera_unavailable', `Camera could not be started: ${(e as Error).name}`); return
      }
      try {
        const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision')
        const files = await FilesetResolver.forVisionTasks(WASM)
        detector = await FaceDetector.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL }, runningMode: 'VIDEO', minDetectionConfidence: 0.5 })
        if (cancelled) { detector.close?.(); return }
      } catch (e) {
        if (cancelled) return
        setStatus('detector_unavailable'); cb.current('detector_unavailable', `Face detector failed to load: ${(e as Error).message}`); return
      }
      let noneSince = 0, multiSince = 0
      const last: Record<string, number> = {}
      timer = window.setInterval(() => {
        const v = videoRef.current
        if (!v || v.readyState < 2 || !detector) return
        const now = Date.now()
        let n = 0
        try { n = detector.detectForVideo(v, performance.now()).detections.length } catch { return }
        if (n === 0) {
          setStatus('none'); multiSince = 0; noneSince ||= now
          if (now - noneSince >= NO_FACE_MS && now - (last.no_face || 0) >= COOLDOWN_MS) { last.no_face = now; cb.current('no_face', 'No face visible for 5+ seconds') }
        } else if (n === 1) { setStatus('one'); noneSince = 0; multiSince = 0 }
        else {
          setStatus('multiple'); noneSince = 0; multiSince ||= now
          if (now - multiSince >= MULTI_MS && now - (last.multiple_faces || 0) >= COOLDOWN_MS) { last.multiple_faces = now; cb.current('multiple_faces', `${n} faces visible for 3+ seconds`) }
        }
      }, 300)
    })()
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
      detector?.close?.()
      stream?.getTracks().forEach(t => t.stop())
      if (videoRef.current) videoRef.current.srcObject = null
    }
  }, [])

  const s = LABEL[status]
  return (
    <div className="card p-3">
      <video ref={videoRef} muted playsInline className="aspect-[4/3] w-full rounded-md bg-black object-cover" aria-label="Live webcam preview" />
      <p role="status" className={`mt-2 rounded px-2 py-1 text-center text-sm font-semibold text-white ${s.c}`}>{s.t}</p>
      <p className="mt-2 text-xs">Frames are analysed in your browser. No video is recorded or uploaded.</p>
    </div>
  )
}
