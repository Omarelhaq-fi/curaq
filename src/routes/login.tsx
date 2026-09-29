import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    mode: search.mode === "signup" ? ("signup" as const) : ("signin" as const),
  }),
  head: () => ({
    meta: [
      { title: "CuraQ | Sign In" },
      {
        name: "description",
        content: "Sign in to your CuraQ workspace to continue preparing for residency.",
      },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Sora:wght@600;700;800&display=swap",
      },
    ],
    scripts: [
      { src: "https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js" },
      { src: "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js" },
    ],
  }),
  component: LoginPage,
});

// ============================================================
// Shared auth plumbing (same Firebase project as landing/app)
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyD_gavsIcvvxe3inU4gSMxe9YRHoW2U9eA",
  authDomain: "exora-web.firebaseapp.com",
  projectId: "exora-web",
  storageBucket: "exora-web.firebasestorage.app",
  messagingSenderId: "294931423657",
  appId: "1:294931423657:web:b440fdd5ce28c31bb6e4b8",
  measurementId: "G-LTCWM5CPVE",
};

const APP_URL = "/app/index.html";

function getFb() {
  const fb = (window as any).firebase;
  if (!fb) throw new Error("Auth is still loading. Please try again in a moment.");
  if (!fb.apps?.length) {
    try {
      fb.initializeApp(firebaseConfig);
    } catch {}
  }
  try {
    fb.auth()
      .setPersistence(fb.auth.Auth.Persistence.LOCAL)
      .catch(() => {});
  } catch {}
  return fb;
}

function friendlyAuthError(err: any): string {
  const code: string = err?.code || "";
  switch (code) {
    case "auth/invalid-email":
      return "That email address doesn't look valid. Please check it and try again.";
    case "auth/user-disabled":
      return "This account has been disabled. Please contact support.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Incorrect email or password. Please try again.";
    case "auth/email-already-in-use":
      return "An account with this email already exists. Try signing in instead.";
    case "auth/weak-password":
      return "Password should be at least 6 characters.";
    case "auth/operation-not-allowed":
      return "Email sign-in is not enabled right now. Please continue with Google.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    case "auth/network-request-failed":
      return "Network error. Check your connection and try again.";
    case "auth/popup-blocked":
      return "Popup was blocked by your browser. Please allow popups for this site and try again.";
    case "auth/unauthorized-domain":
      return "This domain is not authorized for Google Sign-in. Please add it in Firebase Console -> Authentication -> Settings -> Authorized Domains.";
    default:
      return err?.message || "Something went wrong. Please try again.";
  }
}

type Mode = "signin" | "signup";

// ============================================================
// Real question-player preview (right panel, desktop only).
// Mirrors the actual QBank question page (/app question view
// + public/app/assets/qbank-preview.png): header with counter
// and QCM / CAS CLINIQUES tabs, French stem, A–E options and
// the teal Submit Answer bar — cleaned up (no duplicated
// letters) so it reads crisply at any scale.
// Decorative → aria-hidden at the call site.
// ============================================================
function QuestionPlayerPreview() {
  return (
    <div className="bg-[#f1f4f6] overflow-hidden text-left rounded-[14px]">
      <div className="px-6 sm:px-7 py-6">
        {/* header row: counter + tabs (matches real player) */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12.5px] font-bold text-[#0a3d4a] tabular-nums">
            Question 1 of 11
          </span>
          <span className="flex items-center gap-2">
            <span className="text-[11px] font-bold tracking-wide text-[#7c3aed] bg-[#e9d5ff] rounded-full px-3 py-1">
              QCM
            </span>
            <span className="text-[11px] font-bold tracking-wide text-[#0a3d4a]">
              CAS CLINIQUES
            </span>
          </span>
        </div>

        {/* stem — real clinical wording from the question page */}
        <p className="mt-4 text-[13.5px] leading-[1.65] font-medium text-[#0a3d4a]">
          Les premiers gestes à faire sont : A. L&apos;intubation et la ventilation sur tube - B.
          La ventilation au masque — C. Le massage cardiaque externe — D. La stimulation et
          l&apos;aspiration naso-buccale du nouveau-né — E. Glycémie au talon
        </p>

        {/* options A–E (single clean label each) */}
        <div className="flex flex-col gap-2.5 mt-5">
          {["A", "B", "C", "D", "E"].map((k, i) => (
            <div
              key={k}
              className={
                "flex items-center gap-3 rounded-xl border bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(10,61,74,0.05)] " +
                (i === 3 ? "border-[#0e7c86] ring-1 ring-[#0e7c86]/30" : "border-[#e4eaee]")
              }
            >
              <span
                className={
                  "w-4 h-4 rounded-[4px] border-2 grid place-items-center shrink-0 " +
                  (i === 3 ? "border-[#0e7c86] bg-[#0e7c86]/10" : "border-[#cbd5e1] bg-white")
                }
              >
                {i === 3 && (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path
                      d="M1.5 5.2 4 7.5 8.5 2.5"
                      stroke="#0e7c86"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
              <span className="text-[13.5px] font-bold text-[#0a3d4a] w-5 shrink-0">{k}</span>
            </div>
          ))}
        </div>

        {/* submit bar — matches real player teal CTA */}
        <div className="mt-4 rounded-xl bg-[#0e7c86] px-4 py-3.5 text-[13.5px] font-semibold text-white shadow-sm">
          Submit Answer
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Scale-to-fit wrapper: shrinks its content just enough to fit
// the available box, so the page never needs scrolling.
// Vertically centered with a capped scale so the mockup always
// sits inside a safe padding area (no bottom cutoff).
// Desktop only — the right panel is hidden below lg.
// ============================================================
const FIT_DESIGN_WIDTH = 560;

function FitBox({ children }: { children: React.ReactNode }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ s: 1, h: 0 });

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    const update = () => {
      const cw = outer.clientWidth;
      const ch = outer.clientHeight;
      const nh = inner.scrollHeight;
      if (!cw || !ch || !nh) return;
      // Cap at 0.92 so the framed mockup never kisses the viewport edge.
      const s = Math.min(0.92, cw / FIT_DESIGN_WIDTH, ch / nh);
      setBox({ s, h: nh * s });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(outer);
    window.addEventListener("resize", update);
    if (document.fonts?.ready) document.fonts.ready.then(update).catch(() => {});
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <div
      ref={outerRef}
      className="flex-1 min-h-0 overflow-hidden flex items-center justify-center py-4"
    >
      <div
        style={{
          width: FIT_DESIGN_WIDTH,
          height: box.h || "auto",
          transform: `scale(${box.s})`,
          transformOrigin: "center center",
          flexShrink: 0,
        }}
      >
        <div ref={innerRef} style={{ width: FIT_DESIGN_WIDTH }}>
          {children}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Split-screen login page
// DOM order is intentional: <main> form FIRST so screen
// readers + keyboard users land on the action immediately.
// The promo panel is a complementary <aside>, hidden on mobile.
// ============================================================
function LoginPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [mode, setMode] = useState<Mode>(search.mode);
  const [busy, setBusy] = useState(false);
  const [busyEmail, setBusyEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setMode(search.mode);
  }, [search.mode]);

  // Already signed in → go straight to the app
  useEffect(() => {
    let unsub: any;
    const t = setInterval(() => {
      const fb = (window as any).firebase;
      if (!fb) return;
      try {
        if (!fb.apps?.length) fb.initializeApp(firebaseConfig);
        try {
          fb.auth()
            .setPersistence(fb.auth.Auth.Persistence.LOCAL)
            .catch(() => {});
        } catch {}
      } catch {}
      clearInterval(t);

      unsub = fb.auth().onAuthStateChanged((u: any) => {
        if (u) window.location.href = APP_URL;
      });
    }, 100);
    return () => {
      clearInterval(t);
      if (typeof unsub === "function") unsub();
    };
  }, []);

  const switchMode = (m: Mode) => {
    setMode(m);
    setError("");
    navigate({ search: { mode: m } });
  };

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!email.trim() || !password) {
      setError("Please fill in both email and password.");
      return;
    }
    if (isSignupCheck() && password.length < 6) {
      setError("Password should be at least 6 characters.");
      return;
    }
    setBusyEmail(true);
    try {
      const fb = getFb();
      if (mode === "signin") {
        await fb.auth().signInWithEmailAndPassword(email.trim(), password);
      } else {
        await fb.auth().createUserWithEmailAndPassword(email.trim(), password);
      }
      window.location.href = APP_URL;
    } catch (err: any) {
      setError(friendlyAuthError(err));
      setBusyEmail(false);
    }
  };

  function isSignupCheck() {
    return mode === "signup";
  }

  const submitGoogle = async () => {
    setError("");
    setBusy(true);
    try {
      const fb = getFb();
      const provider = new fb.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      provider.addScope("profile");
      provider.addScope("email");
      const result = await fb.auth().signInWithPopup(provider);
      if (result?.user) {
        try {
          const isNew = result.additionalUserInfo && result.additionalUserInfo.isNewUser;
          if (isNew) localStorage.setItem("omnote_theme", "light");
        } catch {}
        window.location.href = APP_URL;
      } else {
        setBusy(false);
      }
    } catch (err: any) {
      if (
        err?.code === "auth/popup-closed-by-user" ||
        err?.code === "auth/cancelled-popup-request"
      ) {
        setBusy(false);
        return;
      }
      setError(friendlyAuthError(err));
      setBusy(false);
    }
  };

  const isSignup = mode === "signup";

  return (
    <div className="exora-login min-h-dvh lg:h-screen lg:overflow-hidden bg-[#f6fafa] text-[#111827]">
      <style>{loginCss}</style>
      {/* shared ambient wash so both halves feel like one surface */}
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute -top-32 -left-32 w-[480px] h-[480px] rounded-full bg-[#0e7c86]/10 blur-3xl" />
        <div className="absolute top-1/3 -right-40 w-[560px] h-[560px] rounded-full bg-[#7cd4df]/20 blur-3xl" />
      </div>

      <div className="relative z-10 w-full min-h-dvh lg:h-full lg:min-h-0 grid grid-cols-1 lg:grid-cols-[5fr_6fr]">
        {/* ============ LEFT: form (first in DOM) ============ */}
        <main
          aria-label={isSignup ? "Create Your CuraQ Account" : "Sign In To CuraQ"}
          className="relative flex flex-col px-6 sm:px-12 xl:px-14 pt-5 pb-5 min-h-dvh lg:min-h-0 lg:h-full lg:overflow-y-auto bg-white lg:rounded-none lg:border-r lg:border-[#e3efef]"
        >
          {/* subtle shared accent echoed from the right panel */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#0e7c86] via-[#7cd4df] to-[#006443]"
          />
          <a href="/" className="flex items-center gap-2 self-start">
            <picture>
              <source
                type="image/webp"
                srcSet="/images/optimized/logo-64.webp 64w, /images/optimized/logo-128.webp 128w"
                sizes="48px"
              />
              <img
                src="/app/assets/logo.png"
                alt="CuraQ logo"
                width={24}
                height={24}
                decoding="async"
                className="w-6 h-6 rounded-[25%] object-cover"
              />
            </picture>
            <span className="font-display text-[17px] font-bold text-[#0e7c86] tracking-tight">
              CuraQ
            </span>
          </a>

          <div className="flex-1 flex flex-col justify-center max-w-sm w-full mx-auto py-6 min-h-0">
            <h1 className="font-display text-[30px] leading-[1.2] font-extrabold tracking-tight text-[#111827] text-center text-balance">
              {isSignup ? "Create Your Account" : "Welcome Back"}
            </h1>
            <p className="text-[13px] leading-[1.6] font-medium text-slate-500 text-center mt-2 mb-6">
              {isSignup
                ? "Start learning smarter, free forever."
                : "Let's get you signed in securely."}
            </p>

            {error && (
              <div
                role="alert"
                aria-live="assertive"
                className="mb-4 px-3 py-2.5 bg-[#fef2f2] border border-[#f8c8c9] rounded-lg text-[#c0392b] text-[12.5px] leading-[1.6] font-semibold"
              >
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={submitGoogle}
              disabled={busy}
              aria-busy={busy}
              className="w-full h-12 mb-4 rounded-xl bg-[#111827] hover:bg-black text-white text-[14px] font-semibold flex items-center justify-center gap-2.5 transition-colors disabled:opacity-60 shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e7c86]"
            >
              <span className="w-6 h-6 rounded-full bg-white grid place-items-center shrink-0">
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 18 18"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z"
                    fill="#4285F4"
                  />
                  <path
                    d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z"
                    fill="#34A853"
                  />
                  <path
                    d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z"
                    fill="#EA4335"
                  />
                </svg>
              </span>
              {busy ? "Please Wait…" : isSignup ? "Sign Up With Google" : "Continue With Google"}
            </button>

            <div className="flex items-center gap-3 my-4" aria-hidden="true">
              <span className="flex-1 h-px bg-[#e3efef]" />
              <span className="text-[11px] font-bold tracking-wider text-slate-400 uppercase">
                or with email
              </span>
              <span className="flex-1 h-px bg-[#e3efef]" />
            </div>

            <form onSubmit={submitEmail} className="flex flex-col gap-2.5">
              <label className="sr-only" htmlFor="exora-email">
                Email address
              </label>
              <input
                id="exora-email"
                type="email"
                autoComplete="email"
                required
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full h-12 px-3.5 rounded-xl border border-[#dbe7e7] bg-white text-[14px] text-[#111827] placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0e7c86]/30 focus:border-[#0e7c86]"
              />
              <label className="sr-only" htmlFor="exora-password">
                Password
              </label>
              <input
                id="exora-password"
                type="password"
                autoComplete={isSignup ? "new-password" : "current-password"}
                required
                placeholder={isSignup ? "Create password (6+ characters)" : "Password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full h-12 px-3.5 rounded-xl border border-[#dbe7e7] bg-white text-[14px] text-[#111827] placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#0e7c86]/30 focus:border-[#0e7c86]"
              />
              <button
                type="submit"
                disabled={busyEmail || busy}
                className="w-full h-12 rounded-xl bg-[#0e7c86] hover:bg-[#0b6770] text-white text-[14px] font-semibold transition-colors disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0e7c86]"
              >
                {busyEmail
                  ? "Please wait…"
                  : isSignup
                    ? "Create account"
                    : "Sign in"}
              </button>
            </form>
            <p className="text-center text-[11.5px] leading-[1.6] font-normal text-slate-500/80 mt-3">
              One-click Google sign-in, no password to remember.
            </p>

            <p className="text-center text-[12.5px] leading-[1.6] font-normal text-slate-500 mt-4">
              {isSignup ? (
                <>
                  Already Have An Account?{" "}
                  <button
                    onClick={() => switchMode("signin")}
                    className="font-bold text-[#0e7c86] hover:underline underline-offset-2"
                  >
                    Sign In
                  </button>
                </>
              ) : (
                <>
                  Don&apos;t Have An Account?{" "}
                  <button
                    onClick={() => switchMode("signup")}
                    className="font-bold text-[#0e7c86] hover:underline underline-offset-2"
                  >
                    Sign Up
                  </button>
                </>
              )}
            </p>

            {/* mobile-only compact reassurance — replaces the heavy preview below lg */}
            <div className="lg:hidden mt-8 rounded-2xl border border-[#e3efef] bg-[#f2f8f8] px-4 py-3.5 flex items-center gap-3">
              <span aria-hidden="true" className="flex -space-x-2">
                {["#0e7c86", "#0a5a3f", "#7cd4df"].map((c) => (
                  <span
                    key={c}
                    className="w-7 h-7 rounded-full ring-2 ring-white grid place-items-center text-[10px] font-bold text-white"
                    style={{ background: c }}
                  >
                    ✓
                  </span>
                ))}
              </span>
              <p className="text-[12px] leading-[1.6] text-[#334e59]">
                <strong className="font-bold text-[#0a3d4a]">47,424+ clinical MCQs</strong>
                <span className="block text-[#6b7f88]">
                  Doctor-verified banks · Tunisia, Algeria, PLAB 1 &amp; USMLE Step 2 CK
                </span>
              </p>
            </div>
          </div>

          <div className="text-[12px] leading-[1.6] text-[#6b7280]">© 2025 CuraQ</div>
        </main>

        {/* ============ RIGHT: promo (desktop only, hidden on mobile/tablet) ============ */}
        <aside
          aria-label="Product Highlights"
          className="relative hidden lg:flex flex-col justify-center px-10 xl:px-14 pt-8 pb-12 min-w-0 lg:h-full lg:min-h-0 lg:overflow-visible bg-gradient-to-b from-[#e9f5f6] via-[#f2f8f8] to-[#f6fafa]"
        >
          {/* seam badge — floats gracefully over the straight seam */}
          <div
            aria-hidden="true"
            className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 z-30 hidden lg:grid w-12 h-12 rounded-full bg-white place-items-center ring-1 ring-black/5 border border-white shadow-[0_4px_12px_rgba(0,0,0,0.08)]"
          >
            <picture>
              <source
                type="image/webp"
                srcSet="/images/optimized/logo-64.webp 64w, /images/optimized/logo-128.webp 128w"
                sizes="48px"
              />
              <img
                src="/app/assets/logo.png"
                alt=""
                width={24}
                height={24}
                loading="lazy"
                decoding="async"
                className="w-6 h-6 rounded-full object-cover"
              />
            </picture>
          </div>
          <div className="flex items-start justify-between gap-4 max-w-2xl w-full mx-auto shrink-0">
            <div>
              <p className="text-[12px] leading-[1.6] font-bold text-[#0e7c86]">What&apos;s New</p>
              <h2 className="font-display text-[20px] leading-[1.25] font-bold text-[#111827] mt-1 text-balance">
                2025/2026 Session Banks Are Live
              </h2>
              <p className="text-[12.5px] leading-[1.6] text-[#6b7280] mt-1.5 max-w-md">
                Tunisia, Algeria, PLAB 1 &amp; USMLE Step 2 CK banks are live. Verified clinical
                stems: clean, clear, and ready to drill.
              </p>
            </div>
            <a
              href="/#exams"
              className="shrink-0 inline-flex items-center gap-1 text-[12px] leading-[1.6] font-semibold text-[#0e7c86] hover:underline underline-offset-2 whitespace-nowrap pt-0.5"
            >
              View All Changes
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden="true"
                className="shrink-0"
              >
                <path
                  d="M2 6h8M6.5 2.5 10 6l-3.5 3.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
          </div>
          <FitBox>
            <div className="relative w-full px-6 pt-2 pb-8">
              {/* soft glow behind the frame — echoes the left accent */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -inset-4 rounded-[28px] bg-gradient-to-br from-[#0e7c86]/20 via-[#7cd4df]/15 to-[#006443]/15 blur-2xl"
              />
              {/* gradient border frame */}
              <div className="relative rounded-2xl bg-gradient-to-br from-[#0e7c86] via-[#7cd4df] to-[#006443] p-[2px] shadow-[0_24px_70px_rgba(11,103,112,0.22)]">
                <div className="rounded-[15px] overflow-hidden bg-white">
                  {/* minimal chrome — no readable URL bar */}
                  <div className="flex items-center gap-2 px-4 py-2.5 bg-[#0a3d4a]">
                    <span className="flex gap-1.5" aria-hidden="true">
                      <span className="w-2.5 h-2.5 rounded-full bg-white/25" />
                      <span className="w-2.5 h-2.5 rounded-full bg-white/25" />
                      <span className="w-2.5 h-2.5 rounded-full bg-white/25" />
                    </span>
                    <span className="mx-auto flex items-center gap-1.5 text-[11px] leading-[1.6] font-semibold text-white/90 bg-white/10 rounded-full px-3 py-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#72daa9]" />
                      CuraQ | Question Player
                    </span>
                    <span className="w-10" />
                  </div>
                  <div aria-hidden="true">
                    <QuestionPlayerPreview />
                  </div>
                </div>
              </div>
              {/* quiet floating badges — short labels only */}
              <div
                aria-hidden="true"
                className="absolute left-0 top-16 bg-white/95 backdrop-blur rounded-xl shadow-lg border border-[#e2e8f0] px-3 py-2 flex items-center gap-2"
              >
                <span className="w-7 h-7 rounded-full bg-[#eef7f2] grid place-items-center text-[14px] text-[#0a5a3f] font-bold">
                  ✓
                </span>
                <span className="text-[11px] leading-[1.4] font-bold text-[#0a3d4a]">
                  Doctor-Verified
                </span>
              </div>
              <div
                aria-hidden="true"
                className="absolute right-1 bottom-6 bg-[#0a3d4a] rounded-xl shadow-lg px-3.5 py-2.5"
              >
                <span className="text-[16px] leading-[1.25] font-extrabold text-white tabular-nums">
                  47,424+
                </span>
                <span className="block text-[10px] font-bold tracking-wider text-[#7cd4df] uppercase">
                  Clinical MCQs
                </span>
              </div>
            </div>
          </FitBox>
          <p className="shrink-0 max-w-2xl w-full mx-auto pt-3 text-[11.5px] leading-[1.6] text-[#6b7f88]">
            Preview is illustrative. Full banks, rationales and tracking unlock after sign-in.
          </p>
        </aside>
      </div>
    </div>
  );
}

const loginCss = `
.exora-login { font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased; line-height: 1.6; }
.exora-login .font-display, .exora-login h1, .exora-login h2 { font-family: 'Sora', 'Inter', system-ui, sans-serif; line-height: 1.25; letter-spacing: -0.02em; }
.exora-login p { line-height: 1.6; }
`;
