import { useEffect, useState } from 'react'
import LandingPage from './components/LandingPage'
import InstructionsPage from './components/InstructionsPage'
import AssessmentPage from './components/AssessmentPage'
import ResultsPage from './components/ResultsPage'
import AdminDashboard from './components/AdminDashboard'

export const go = (path: string) => { window.location.hash = path }

export default function App() {
  const [hash, setHash] = useState(window.location.hash || '#/')
  useEffect(() => {
    const h = () => setHash(window.location.hash || '#/')
    window.addEventListener('hashchange', h)
    return () => window.removeEventListener('hashchange', h)
  }, [])
  const [, route, param] = hash.split('/')
  switch (route) {
    case 'instructions': return <InstructionsPage />
    case 'assessment': return <AssessmentPage />
    case 'results': return <ResultsPage />
    case 'admin': return <AdminDashboard />
    default: return <LandingPage />
  }
}
