import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "CuraQ | Free Medical QBank" },
      {
        name: "description",
        content:
          "CuraQ is a free Medical QBank featuring high-yield questions across all specialties. 100% free forever.",
      },
      { property: "og:title", content: "CuraQ | Free Medical QBank" },
      {
        property: "og:description",
        content:
          "Practice with our massive clinical question bank, covering all specialties and years. 100% free forever.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      // LCP hero image, preloaded in the right size (responsive WebP set).
      {
        rel: "preload",
        as: "image",
        href: "/images/optimized/hero-doctor-1280.webp",
        imageSrcSet:
          "/images/optimized/hero-doctor-768.webp 768w, /images/optimized/hero-doctor-1280.webp 1280w, /images/optimized/hero-doctor-1920.webp 1920w",
        imageSizes: "100vw",
        // @ts-expect-error fetchpriority is valid on preload links
        fetchpriority: "high",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap",
      },
    ],
    scripts: [
      { src: "https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js" },
      { src: "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js" },
    ],
  }),
  component: Landing,
});

const firebaseConfig = {
  apiKey: "AIzaSyD_gavsIcvvxe3inU4gSMxe9YRHoW2U9eA",
  authDomain: "exora-web.firebaseapp.com",
  projectId: "exora-web",
  storageBucket: "exora-web.firebasestorage.app",
  messagingSenderId: "294931423657",
  appId: "1:294931423657:web:b440fdd5ce28c31bb6e4b8",
  measurementId: "G-LTCWM5CPVE",
};

function bootstrapLandingFirebase() {
  const w = window as any;
  const fb = w.firebase;
  if (!fb || w.omnoteLandingBootstrapped) return !!fb;
  try {
    if (!fb.apps?.length) fb.initializeApp(firebaseConfig);
    try {
      fb.auth().setPersistence(fb.auth.Auth.Persistence.LOCAL).catch(() => {});
    } catch {}
    w.omnoteLandingBootstrapped = true;
    return true;
  } catch {
    return false;
  }
}

const APP_URL = "/app/index.html";

function CuraQMark({ size = 26 }: { size?: number }) {
  return (
    <picture>
      <source
        type="image/webp"
        srcSet="/images/optimized/logo-64.webp 64w, /images/optimized/logo-128.webp 128w"
        sizes={`${Math.ceil(size * 2)}px`}
      />
      <img
        src="/app/assets/logo.png"
        alt="CuraQ Logo"
        width={size}
        height={size}
        decoding="async"
        style={{ width: size, height: size, borderRadius: "25%", objectFit: "cover" }}
      />
    </picture>
  );
}

function SiteHeader({ onSignin, onSignup }: { onSignin: () => void; onSignup: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    const hero = document.getElementById("hero");
    if (!hero) {
      setSolid(true);
      return;
    }
    const obs = new IntersectionObserver(([entry]) => setSolid(!entry.isIntersecting), {
      rootMargin: "-64px 0px 0px 0px",
    });
    obs.observe(hero);
    return () => obs.disconnect();
  }, []);
  const links = [
    { label: "Home", href: "#home" },
    { label: "Contact Us", href: "/contact-us" },
  ];
  return (
    <header
      className={`fixed top-0 left-0 w-full z-50 transition-colors duration-200 ${
        solid
          ? "bg-white shadow-[0_1px_3px_rgba(0,0,0,0.05)]"
          : "bg-transparent"
      }`}
    >
      <div className="h-[64px] max-w-7xl mx-auto px-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 shrink-0">
          <a href="#home" className="flex items-center gap-2">
            <CuraQMark size={30} />
            <span
              className={`font-display text-[18px] font-bold tracking-tight ${
                solid ? "text-[#0a3d4a]" : "text-white drop-shadow-md"
              }`}
            >
              CuraQ
            </span>
          </a>
        </div>
        <nav className="hidden xl:flex items-center gap-6">
          {links.map((l) => (
            <a
              key={l.label}
              href={l.href}
              className={`transition-colors text-[15px] font-bold ${
                solid
                  ? "text-[#0a3d4a] hover:text-[#0e7c86]"
                  : "text-white hover:text-[#98f0fb] drop-shadow-md"
              }`}
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-4 shrink-0">
          <button
            onClick={onSignin}
            className={`hidden sm:block text-[15px] font-bold transition-colors ${
              solid ? "text-[#0a3d4a] hover:text-[#0e7c86]" : "text-white hover:text-[#98f0fb] drop-shadow-md"
            }`}
          >
            Sign in
          </button>
          <button
            onClick={onSignup}
            className={`text-[14px] font-semibold py-1.5 px-4 rounded-md ${
              solid
                ? "bg-[#0e7c86] text-white hover:bg-[#0b6770]"
                : "bg-[#0e7c86] text-white hover:bg-[#0b6770]"
            } shadow-sm transition-colors`}
          >
            Start Free
          </button>
          <button
            className={`xl:hidden w-8 h-8 grid place-items-center rounded transition-colors ${
              solid ? "hover:bg-gray-100 text-[#0a3d4a]" : "hover:bg-black/20 text-white"
            }`}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Toggle menu"
          >
            <span className="material-symbols-outlined text-[24px]">
              {menuOpen ? "close" : "menu"}
            </span>
          </button>
        </div>
      </div>
      {menuOpen && (
        <nav className="xl:hidden border-t border-gray-100 bg-white px-6 py-4 flex flex-col gap-3 shadow-md">
          {links.map((l) => (
            <a
              key={l.label}
              href={l.href}
              onClick={() => setMenuOpen(false)}
              className="text-[15px] font-medium text-[#475467] hover:text-[#0e7c86]"
            >
              {l.label}
            </a>
          ))}
          <button
            onClick={() => {
              setMenuOpen(false);
              onSignin();
            }}
            className="sm:hidden text-left text-[15px] font-medium text-[#475467] hover:text-[#0e7c86]"
          >
            Sign in
          </button>
        </nav>
      )}
    </header>
  );
}

function Landing() {
  const navigate = useNavigate();
  const open = (mode: "signin" | "signup") => {
    navigate({ to: "/login", search: { mode } });
  };

  useEffect(() => {
    bootstrapLandingFirebase();
    const t = setInterval(() => {
      const w = window as any;
      const fb = w.firebase;
      if (!fb || !fb.auth) return;
      let unsub: any;
      unsub = fb.auth().onAuthStateChanged((u: any) => {
        if (u) window.location.href = APP_URL;
      });
    }, 100);
    return () => clearInterval(t);
  }, []);

  return (
    <div id="home" className="exora-landing bg-[#ffffff] text-[#333333] antialiased">
      <style>{css}</style>
      <SiteHeader onSignin={() => open("signin")} onSignup={() => open("signup")} />

      <main className="w-full bg-[#ffffff]">
        {/* HERO */}
        <section id="hero" className="relative w-full h-[100dvh] min-h-[600px] flex overflow-hidden">
          <picture>
            <source
              type="image/webp"
              srcSet="/images/optimized/hero-doctor-768.webp 768w, /images/optimized/hero-doctor-1280.webp 1280w, /images/optimized/hero-doctor-1920.webp 1920w"
              sizes="100vw"
            />
            <img
              src="/images/hero-doctor.jpg"
              alt=""
              aria-hidden
              width={1920}
              height={1280}
              fetchPriority="high"
              decoding="async"
              className="absolute inset-0 w-full h-full object-cover object-[center_10%] scale-[1.15]"
            />
          </picture>
          <div className="absolute inset-0 bg-gradient-to-r from-black/60 to-black/20" />
          <div className="relative flex-1 w-full max-w-7xl mx-auto px-6 md:px-12 flex flex-col justify-center">
            <div className="max-w-2xl flex flex-col items-start gap-2 md:gap-4 mt-12 md:mt-24">
              <h1 className="text-[34px] md:text-[54px] font-extrabold text-white leading-[1.1] tracking-tight drop-shadow-lg">
                Your Journey to Medical Mastery Begins Here
              </h1>
              <p className="text-[18px] md:text-[24px] font-medium text-white/95 leading-tight drop-shadow-md">
                Uncompromising Clinical Preparation
              </p>
            </div>
          </div>
          
          {/* UWorld style bottom bar overlaying the hero */}
          <div className="absolute bottom-0 w-full bg-[#051a21]/95 border-t border-[#0e7c86]/30 backdrop-blur-md">
            <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between text-white text-[13px]">
              <div>
                <strong className="text-white">NEW PRODUCT</strong>
                <span className="mx-3 text-[#aaaaaa]">|</span>
                <span>Access fast, trusted clinical insights for your exam prep and daily ward rounds. Explore the <a href="/login" className="text-[#98f0fb] font-semibold hover:underline">Medical Library ›</a></span>
              </div>
            </div>
          </div>
        </section>

        <section className="w-full py-24 px-6 max-w-6xl mx-auto">
          <div className="text-center mb-20">
            <h2 className="text-[28px] md:text-[36px] font-bold text-[#0a3d4a] mb-6 tracking-tight">
              Concept Mastery is the Key to Clinical Success
            </h2>
            <p className="text-[16px] md:text-[18px] leading-[28px] text-[#5c727d] max-w-3xl mx-auto">
              At CuraQ, we go beyond simple pattern recognition. We build the foundational clinical intuition you need to not just pass the exam, but to excel as a physician. Our rigorous methodology sets the new standard for licensure preparation globally.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-16 items-start">
            <div className="flex gap-6 bg-[#f4f8f9] p-8 rounded-2xl border border-[#e6f0f2] transition-transform hover:-translate-y-1 duration-300 shadow-sm">
              <div className="w-16 h-16 rounded-full bg-[#0e7c86]/10 flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-[32px] text-[#0e7c86]">verified_user</span>
              </div>
              <div>
                <h4 className="text-[18px] font-bold text-[#0a3d4a] mb-3">
                  Unshakeable Exam Confidence
                </h4>
                <p className="text-[14px] text-[#5c727d] leading-[24px]">
                  Our vignettes match or exceed the difficulty of the real exam. By practicing with our high-fidelity interface, you'll walk into the testing center feeling like you've been there before.
                </p>
              </div>
            </div>
            <div className="flex gap-6 bg-[#f4f8f9] p-8 rounded-2xl border border-[#e6f0f2] transition-transform hover:-translate-y-1 duration-300 shadow-sm">
              <div className="w-16 h-16 rounded-full bg-[#0e7c86]/10 flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-[32px] text-[#0e7c86]">psychology</span>
              </div>
              <div>
                <h4 className="text-[18px] font-bold text-[#0a3d4a] mb-3">
                  First-Principles Explanations
                </h4>
                <p className="text-[14px] text-[#5c727d] leading-[24px]">
                  Every question breaks down the 'why' using core pathophysiology. Authored by top-scoring clinicians, our explanations ensure you never miss the same concept twice.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="w-full py-24 px-6 bg-[#0a3d4a] text-center text-white relative overflow-hidden">
          <div
            className="absolute inset-0 opacity-5"
            style={{
              backgroundImage:
                "radial-gradient(circle at 25% 25%, rgba(255,255,255,0.6) 1px, transparent 1px)",
              backgroundSize: "22px 22px",
            }}
          ></div>
          <div className="max-w-4xl mx-auto">
            <h2 className="text-[28px] md:text-[36px] font-bold mb-6 tracking-tight">
              The CuraQ Difference
            </h2>
            <p className="text-[14px] leading-[26px] text-white/90">
              Merging academic excellence with digital innovation, we develop online learning tools of the highest standards that have the greatest positive impact on our users. Our question banks (QBanks) are built from the ground up by a dedicated team of content developers who were all top-scorers on their exams. Our obsession with quality and singular focus on student outcomes compels us to produce only the best material, which is why thousands of medical students have chosen CuraQ as their exam preparation product of choice.
            </p>
          </div>
        </section>

        {/* CONTACT / PARTNERSHIP */}
        <section className="w-full py-24 px-6 bg-white">
          <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center gap-12">
            <div className="w-full md:w-1/2 rounded overflow-hidden">
              <picture>
                <source
                  type="image/webp"
                  srcSet="/images/optimized/institutional-doctors-640.webp 640w, /images/optimized/institutional-doctors-960.webp 960w"
                  sizes="(max-width: 768px) 100vw, 50vw"
                />
                <img
                  src="/images/institutional_doctors_realistic.png"
                  alt="Doctors collaborating"
                  width={960}
                  height={960}
                  loading="lazy"
                  decoding="async"
                  className="w-full h-auto object-cover max-h-[300px]"
                />
              </picture>
            </div>
            <div className="w-full md:w-1/2 flex flex-col items-start text-left">
              <h2 className="text-[26px] md:text-[30px] font-light text-[#555555] mb-4">
                Have questions or feedback?
              </h2>
              <p className="text-[14px] leading-[24px] text-[#777777] mb-6">
                Our team is here to help. Whether you have a question about our QBanks, need technical support, or just want to share your thoughts — we'd love to hear from you.
              </p>
              <a href="/contact-us" className="bg-[#0e7c86] hover:bg-[#0b6770] text-white text-[15px] font-bold py-3.5 px-8 rounded-lg shadow-md transition-all hover:shadow-lg hover:-translate-y-0.5">
                Contact Us
              </a>
            </div>
          </div>
        </section>

        {/* FOOTER */}
        <footer className="w-full bg-[#151c22] text-[#cccccc] py-20 px-6">
          <div className="max-w-6xl mx-auto flex flex-col items-center">
            <h2 className="text-[28px] md:text-[34px] font-bold text-white mb-2 tracking-tight">
              Explore All CuraQ QBanks
            </h2>
            <p className="text-[15px] text-[#777777] mb-16">Select your region and examination</p>

            <div className="flex flex-col items-center">
              <div>
                <h4 className="text-white font-bold mb-6">North Africa</h4>
                <ul className="flex flex-col gap-4">
                  <li><a href="/qbanks/tunisia" className="hover:text-white transition-colors">Examen Blanc Résidanat</a></li>
                  <li><a href="/qbanks/tunisia" className="hover:text-white transition-colors">Tunisia Board Exam</a></li>
                  <li><a href="/qbanks/egypt" className="hover:text-white transition-colors">Egypt Clinical Bank</a></li>
                </ul>
              </div>
            </div>
            
            <div className="w-full mt-20 pt-8 border-t border-[#333333] flex flex-col md:flex-row items-center justify-between text-[12px] gap-4">
              <div className="flex items-center gap-4">
                <a href="/terms-of-service" className="hover:text-white">Terms of Service</a>
                <a href="/privacy-policy" className="hover:text-white">Privacy Policy</a>
                <a href="/refund-policy" className="hover:text-white">Refund Policy</a>
              </div>
              <div>© 2026 CuraQ Medical Education Technologies</div>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}

const css = `
.exora-landing { font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif; }
.exora-landing .font-display, .exora-landing h1, .exora-landing h2, .exora-landing h3 { font-family: 'Inter', system-ui, sans-serif; }
html { scroll-behavior: smooth; }
.material-symbols-outlined { font-variation-settings: 'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 48; }
`;
