import { createFileRoute, useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/qbanks/usmle")({
  head: () => ({
    meta: [
      { title: "USMLE Step 1 & 2 CK Prep | CuraQ Free Medical QBank" },
      {
        name: "description",
        content: "Master the USMLE with our comprehensive, 100% free QBank. High-yield questions, deep explanations, and performance tracking.",
      },
    ],
  }),
  component: USMLEQBank,
});

function USMLEQBank() {
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
            USMLE® Step 1 & Step 2 CK QBank
          </h1>
          <p className="text-[18px] text-[#666666] leading-relaxed max-w-2xl">
            Pass the boards with confidence. Thousands of high-yield questions written by top-scoring physicians, designed to match the exact difficulty and interface of the real USMLE.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-16">
          <div className="bg-[#f9f9f9] p-8 rounded-lg border border-gray-100">
            <h3 className="text-[20px] font-bold mb-3 text-[#0e7c86]">Exam-Level Difficulty</h3>
            <p className="text-[14px] text-[#555555] leading-relaxed">
              Don't get caught off guard on test day. Our stems are lengthy, complex, and require the multi-step reasoning expected on the modern USMLE examinations.
            </p>
          </div>
          <div className="bg-[#f9f9f9] p-8 rounded-lg border border-gray-100">
            <h3 className="text-[20px] font-bold mb-3 text-[#0e7c86]">Conceptual Explanations</h3>
            <p className="text-[14px] text-[#555555] leading-relaxed">
              We focus on the 'why'. Every answer choice, correct or incorrect, is thoroughly explained using first principles of pathophysiology and pharmacology.
            </p>
          </div>
        </div>

        <div className="text-center bg-[#0a3d4a] text-white rounded-lg p-12">
          <h2 className="text-[28px] font-bold mb-4">Start your USMLE prep today.</h2>
          <p className="text-[16px] text-white/90 mb-8 max-w-xl mx-auto">
            Stop paying thousands of dollars for prep materials. Get premium-quality USMLE practice completely free.
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
