import type { CandidateQuestion } from '../types'
export default function QuestionCard({ q, index, total, selected, onSelect }: { q: CandidateQuestion; index: number; total: number; selected?: number; onSelect: (i: number) => void }) {
  return (
    <section className="card" aria-labelledby="qtext">
      <p className="text-sm font-semibold text-ashley">Question {index + 1} of {total} · {q.category}</p>
      <h2 id="qtext" className="mt-2 text-xl font-bold">{q.text}</h2>
      <div className="mt-5 space-y-3" role="radiogroup" aria-labelledby="qtext">
        {q.options.map((o, i) => (
          <label key={i} className={`flex cursor-pointer items-center gap-3 rounded-md border-2 p-3 ${selected === i ? 'border-ashley bg-orange-50' : 'border-gray-200 hover:border-charcoal'}`}>
            <input type="radio" name={q.id} checked={selected === i} onChange={() => onSelect(i)} className="h-4 w-4 accent-[#F58232]" />
            <span>{o}</span>
          </label>
        ))}
      </div>
    </section>
  )
}
