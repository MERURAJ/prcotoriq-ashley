import { useEffect, useRef, useState } from 'react'
// Remaining time is always derived from the absolute deadline, never from counting ticks.
export default function CountdownTimer({ deadline, onExpire }: { deadline: number; onExpire: () => void }) {
  const [left, setLeft] = useState(() => Math.max(0, deadline - Date.now()))
  const cb = useRef(onExpire); cb.current = onExpire
  useEffect(() => {
    const tick = () => { const l = Math.max(0, deadline - Date.now()); setLeft(l); if (l === 0) { clearInterval(id); cb.current() } }
    const id = setInterval(tick, 250); tick()
    return () => clearInterval(id)
  }, [deadline])
  const s = Math.ceil(left / 1000)
  const text = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return <div role="timer" aria-label={`Time remaining ${text}`} className={`rounded-md px-4 py-2 text-2xl font-extrabold tabular-nums ${s <= 60 ? 'bg-red-600 text-white' : 'bg-charcoal text-white'}`}>{text}</div>
}
