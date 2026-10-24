import { go } from '../App'
export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col items-center justify-between px-6 py-10 text-center">
      <img src="/ashley-logo.jpeg" alt="Ashley Furniture India Pvt. Ltd." className="h-auto w-full max-w-[420px] object-contain" />
      <div className="py-12">
        <h1 className="text-4xl font-extrabold leading-tight text-charcoal sm:text-6xl">
          GET THE <span className="text-ashley">RIGHT JOB</span> THAT YOU DESERVE
        </h1>
        <button onClick={() => go('/instructions')} className="btn btn-primary mt-10 px-12 py-4 text-lg">Get Started</button>
      </div>
      <a href="#/admin" className="text-sm text-charcoal underline">Admin login</a>
    </main>
  )
}
