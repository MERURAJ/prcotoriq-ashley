import type { Attempt } from './types'

const ACTIVE = 'proctoriq_active'

export const loadActive = (): Attempt | null => {
  const raw = localStorage.getItem(ACTIVE)
  if (!raw) return null
  const attempt: unknown = JSON.parse(raw)
  if (!attempt || typeof attempt !== 'object') return null
  const value = attempt as Partial<Attempt>
  return typeof value.id === 'string' && typeof value.name === 'string' &&
    typeof value.startedAt === 'number' && Array.isArray(value.questions) &&
    value.answers !== null && typeof value.answers === 'object' &&
    Array.isArray(value.events) ? value as Attempt : null
}

export const saveActive = (attempt: Attempt) => localStorage.setItem(ACTIVE, JSON.stringify(attempt))
export const clearActive = () => localStorage.removeItem(ACTIVE)
