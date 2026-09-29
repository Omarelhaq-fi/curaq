import { createFileRoute, useNavigate } from "@tanstack/react-router";

export const Route = createFileRoute("/qbanks/plab")({
  head: () => ({
    meta: [
      { title: "PLAB 1 Preparation | CuraQ Free Medical QBank" },
      {
        name: "description",
        content: "The ultimate free PLAB 1 question bank. Practice with thousands of GMC-style questions and clinical scenarios to pass the UK medical licensing exam.",
      },
    ],
  }),
  component: PLABQBank,
});

function PLABQBank() {
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
            PLAB 1 Question Bank
          </h1>
          <p className="text-[18px] text-[#666666] leading-relaxed max-w-2xl">
            Pass the Professional and Linguistic Assessments Board test with confidence. Comprehensive practice covering all major specialties and clinical presentations required by the GMC.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-16">
          <div className="bg-[#f9f9f9] p-8 rounded-lg border border-gray-100">
            <h3 className="text-[20px] font-bold mb-3 text-[#0e7c86]">GMC-Style Scenarios</h3>
            <p className="text-[14px] text-[#555555] leading-relaxed">
              Our questions are meticulously crafted to mirror the style and format of the actual PLAB 1 exam. Practice single best answer (SBA) questions covering acute and chronic clinical scenarios.
            </p>
          </div>
          <div className="bg-[#f9f9f9] p-8 rounded-lg border border-gray-100">
            <h3 className="text-[20px] font-bold mb-3 text-[#0e7c86]">UK Guidelines (NICE)</h3>
            <p className="text-[14px] text-[#555555] leading-relaxed">
              Every explanation is based on the latest NICE guidelines and UK clinical practice. Ensure you are learning the correct, up-to-date management plans expected in the NHS.
            </p>
          </div>
        </div>

        <div className="text-center bg-[#0a3d4a] text-white rounded-lg p-12">
          <h2 className="text-[28px] font-bold mb-4">Start your journey to the NHS.</h2>
          <p className="text-[16px] text-white/90 mb-8 max-w-xl mx-auto">
            Get premium-quality PLAB 1 preparation for absolutely free. Track your progress and master clinical concepts today.
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
