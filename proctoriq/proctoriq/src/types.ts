export type EventType = 'tab_switch' | 'fullscreen_exit' | 'no_face' | 'multiple_faces' | 'camera_unavailable' | 'detector_unavailable'
export interface ProctorEvent { type: EventType; at: string; detail: string }
export type CodingLanguage = 'python' | 'cpp' | 'java'
export type CodeInput = string | number | boolean | null | CodeInput[] | { [key: string]: CodeInput }
export interface CodeExample { input: CodeInput; output: string }
export interface CodeTestCase { input: CodeInput; expectedOutput: string }
export interface CandidateQuestion {
  id: string; category: string; text: string; kind?: 'mcq' | 'coding'; options: string[]
  examples?: CodeExample[]; constraints?: string
}
export interface AdminQuestion extends CandidateQuestion { answer?: number; testCases?: CodeTestCase[] }
export interface CodeAnswer {
  language: CodingLanguage; source: string
  submitted?: { language: CodingLanguage; source: string; passed: number; total: number; score: number }
}
export interface Attempt {
  id: string; name: string; startedAt: number; questions: CandidateQuestion[]
  answers: Record<string, number>; events: ProctorEvent[]; cameraRequested: boolean
  codeAnswers?: Record<string, CodeAnswer>
}
export interface Result {
  id: string; name: string; startedAt: string; submittedAt: string
  score: number; total: number; percentage: number
  mcqScore?: number; mcqTotal?: number; codingScore?: number; codingTotal?: number
  tabSwitchCount: number; fullscreenExitCount?: number; webcamEventCount: number; events: ProctorEvent[]
  codingSubmissions?: Record<string, { language: CodingLanguage; source: string; score: number; passed: number; total: number; submittedAt: string }>
  autoSubmitted: boolean
}
export const DURATION_MS = 10 * 60 * 1000
