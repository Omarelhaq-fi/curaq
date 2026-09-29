import { createFileRoute, useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/qbanks/egypt")({
  head: () => ({
    meta: [
      { title: "Egypt Clinical Bank | CuraQ Free Medical QBank" },
      {
        name: "description",
        content: "Free QBank for the Egyptian Medical Syndicate & University Fellowship. Practice with clinical cases and high-yield questions.",
      },
    ],
  }),
  component: EgyptQBank,
});

function EgyptQBank() {
  const navigate = useNavigate();
  return (
    <div className="bg-[#ffffff] min-h-screen text-[#333333] font-sans">
      <header className="w-full bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <a href="/" className="font-bold text-[18px] text-[#0a3d4a]">CuraQ</a>
          <button
            onClick={() => navigate({ to: "/login", search: { mode: "signup" } })}
            className="bg-[#0e7c86] hover:bg-[#0b6770] text-white text-[14px] font-semibold py-2 px-4 rounded transition-colors"
          >
            Start Practicing for Free
          </button>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-20">
        <div className="mb-12">
          <h1 className="text-[32px] md:text-[42px] font-bold text-[#333333] leading-tight mb-4">
            Egypt Clinical QBank
          </h1>
          <p className="text-[18px] text-[#666666] leading-relaxed max-w-2xl">
            The definitive resource for Egyptian Medical Syndicate & University Fellowship exams. Features over 11,000+ single best answer questions and clinical cases.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-16">
          <div className="bg-[#f9f9f9] p-8 rounded-lg border border-gray-100">
            <h3 className="text-[20px] font-bold mb-3 text-[#0e7c86]">Authentic Exam Format</h3>
            <p className="text-[14px] text-[#555555] leading-relaxed">
              Questions modeled directly after the real exams from 2016 to 2024. Drill clinical cases specifically tailored to the Egyptian medical curriculum and standards of practice.
            </p>
          </div>
          <div className="bg-[#f9f9f9] p-8 rounded-lg border border-gray-100">
            <h3 className="text-[20px] font-bold mb-3 text-[#0e7c86]">Spaced Repetition Integration</h3>
            <p className="text-[14px] text-[#555555] leading-relaxed">
              Turn your weakest topics into strengths using our built-in FSRS spaced-repetition flashcard engine. Seamlessly convert difficult questions into daily review cards.
            </p>
          </div>
        </div>

        <div className="text-center bg-[#0a3d4a] text-white rounded-lg p-12">
          <h2 className="text-[28px] font-bold mb-4">Advance Your Medical Career in Egypt</h2>
          <p className="text-[16px] text-white/90 mb-8 max-w-xl mx-auto">
            Get access to the most comprehensive and rapidly growing clinical bank for Egyptian fellowships, completely free of charge.
          </p>
          <button
            onClick={() => navigate({ to: "/login", search: { mode: "signup" } })}
            className="bg-white hover:bg-gray-100 text-[#0a3d4a] text-[16px] font-bold py-3 px-8 rounded-full shadow-sm transition-colors"
          >
            Create Free Account
          </button>
        </div>
      </main>
    </div>
  );
}
