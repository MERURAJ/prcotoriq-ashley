export type FullscreenStart = 'entered' | 'unavailable'

let startState: FullscreenStart | null = null

export const setFullscreenStart = (state: FullscreenStart) => { startState = state }
export const consumeFullscreenStart = () => {
  const state = startState
  startState = null
  return state
}
