import { createFileRoute, useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/qbanks/tunisia")({
  head: () => ({
    meta: [
      { title: "Examen Blanc Résidanat | CuraQ Free Medical QBank" },
      {
        name: "description",
        content: "Practice with the most comprehensive free question bank for the Tunisia Examen Blanc Résidanat. Real past papers, detailed explanations, and 100% free.",
      },
    ],
  }),
  component: TunisiaQBank,
});

function TunisiaQBank() {
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
            Examen Blanc Résidanat QBank
          </h1>
          <p className="text-[18px] text-[#666666] leading-relaxed max-w-2xl">
            The ultimate free resource for medical students preparing for the Tunisian National Board exams (FMT, FMS, FMM). Over 35,000+ verified questions and clinical cases.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-16">
          <div className="bg-[#f9f9f9] p-8 rounded-lg border border-gray-100">
            <h3 className="text-[20px] font-bold mb-3 text-[#0e7c86]">Past Papers from 2015-2024</h3>
            <p className="text-[14px] text-[#555555] leading-relaxed">
              Drill down into specific session exams from the last decade. Our database is regularly updated with the latest faculty questions to ensure you are practicing with highly relevant, up-to-date material.
            </p>
          </div>
          <div className="bg-[#f9f9f9] p-8 rounded-lg border border-gray-100">
            <h3 className="text-[20px] font-bold mb-3 text-[#0e7c86]">Doctor-Verified Explanations</h3>
            <p className="text-[14px] text-[#555555] leading-relaxed">
              Every single question comes with detailed pathophysiological rationale. Understand exactly why an answer is correct, and why every other distractor is wrong, ensuring deep concept mastery.
            </p>
          </div>
        </div>

        <div className="text-center bg-[#0a3d4a] text-white rounded-lg p-12">
          <h2 className="text-[28px] font-bold mb-4">Ready to master the Résidanat?</h2>
          <p className="text-[16px] text-white/90 mb-8 max-w-xl mx-auto">
            Join thousands of medical students using CuraQ to achieve their highest possible scores. 100% free forever, no credit card required.
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
