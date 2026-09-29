import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy-policy")({
  head: () => ({
    meta: [
      { title: "CuraQ | Privacy Policy" },
      { name: "description", content: "Privacy Policy for CuraQ." },
    ],
  }),
  component: PrivacyPolicy,
});

function PrivacyPolicy() {
  return (
    <div className="on-landing">
      <style>{css}</style>
      
      <header className="on-nav-wrap">
        <nav className="on-nav">
          <Link to="/" className="on-brand">
            <img src="/app/assets/logo.png" alt="" />
            <span>CuraQ</span>
          </Link>
          <div className="on-nav-cta">
            <Link to="/" className="on-btn on-btn-ghost">Back to Home</Link>
          </div>
        </nav>
      </header>

      <section className="on-hero" style={{ paddingBottom: '40px' }}>
        <div className="on-hero-inner" style={{ gridTemplateColumns: '1fr', textAlign: 'center' }}>
          <div className="on-hero-copy" style={{ margin: '0 auto' }}>
            <h1>Privacy Policy</h1>
            <p className="on-lede" style={{ margin: '0 auto' }}>
              How we collect, use, and protect your data while you study.
            </p>
          </div>
        </div>
      </section>

      <section className="on-section" style={{ paddingTop: '40px', maxWidth: '800px', margin: '0 auto' }}>
        <div className="policy-content">
          <p><strong>Effective Date:</strong> August 2026</p>
          
          <h3>1. Information We Collect</h3>
          <p>
            When you use CuraQ, we collect information you provide directly to us. This includes your account details (email address, name, avatar) when you register, as well as the study materials you upload (such as PDFs, PowerPoints, and notes). 
          </p>

          <h3>2. How We Use Your Data (AI Processing)</h3>
          <p>
            The core feature of CuraQ is generating study aids (flashcards, MCQs, summaries) using Artificial Intelligence. To do this, the documents and text you upload are processed by our secure AI partners. Your documents are used strictly to generate your personal study materials and are <strong>never</strong> used to train public AI models.
          </p>

          <h3>3. Data Storage & Security</h3>
          <p>
            Your account data, uploaded files, and generated study materials are stored securely using Google Firebase infrastructure. We employ industry-standard security measures to protect your information from unauthorized access or alteration. However, please remember that no method of transmission over the internet is 100% secure.
          </p>

          <h3>4. Data Sharing</h3>
          <p>
            We do not sell, rent, or trade your personal information or study documents to third parties. We only share necessary data with our trusted service providers (like our cloud hosting and AI API providers) strictly for the purpose of operating the CuraQ service.
          </p>

          <h3>5. Your Rights & Data Deletion</h3>
          <p>
            You own the study materials you upload. You have the right to access, update, or delete your data at any time. If you wish to permanently delete your account and all associated data, you can do so from your profile settings or by opening a support ticket.
          </p>

          <h3>6. Contact Us</h3>
          <p>
            If you have questions about this Privacy Policy, please log in to your account and open a support ticket from your dashboard.
          </p>
        </div>
      </section>

      <footer className="on-foot">
        <div className="on-foot-inner">
          <Link to="/" className="on-brand">
            <img src="/app/assets/logo.png" alt="" />
            <span>CuraQ</span>
          </Link>
          <div className="on-foot-links">
            <Link to="/terms-of-service">Terms of Service</Link>
            <Link to="/privacy-policy">Privacy Policy</Link>
            <Link to="/refund-policy">Refund Policy</Link>
            <Link to="/contact-us">Contact Us</Link>
          </div>
          <div className="on-foot-copy">© {new Date().getFullYear()} CuraQ</div>
        </div>
      </footer>
    </div>
  );
}

const css = `
.on-landing { min-height: 100vh; background: #ffffff; color: #0a3d4a; font-family: 'Figtree', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
.on-landing *, .on-landing *::before, .on-landing *::after { box-sizing: border-box; }
.on-landing a { text-decoration: none; color: inherit; }
.on-landing h1, .on-landing h2, .on-landing h3, .on-landing h4 { font-family: 'Outfit', 'Figtree', sans-serif; color: #0a3d4a; margin: 0; letter-spacing: -0.02em; font-weight: 700; }
.on-landing p { color: #334e59; margin: 0; }

.on-nav-wrap { position: sticky; top: 0; z-index: 50; background: rgba(255,255,255,0.92); backdrop-filter: saturate(140%) blur(8px); border-bottom: 1px solid #e4eaee; }
.on-nav { max-width: 1200px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 14px 24px; }
.on-brand { display: flex; align-items: center; gap: 10px; font-family: 'Outfit', sans-serif; font-weight: 800; font-size: 19px; color: #0a3d4a; }
.on-brand img { width: 28px; height: 28px; border-radius: 6px; }
.on-nav-cta { display: flex; gap: 8px; }

.on-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 18px; border-radius: 8px; font-family: inherit; font-size: 14.5px; font-weight: 600; border: 1px solid transparent; cursor: pointer; transition: background .15s ease, color .15s ease, border-color .15s ease; white-space: nowrap; }
.on-btn-ghost { background: transparent; color: #0a3d4a; }
.on-btn-ghost:hover { background: #eef4f5; }

.on-hero { padding: 72px 24px 88px; background: linear-gradient(180deg, #ffffff 0%, #f4f6f8 100%); border-bottom: 1px solid #eef2f4; }
.on-hero-inner { max-width: 1200px; margin: 0 auto; display: grid; }
.on-hero-copy h1 { font-size: clamp(38px, 5.6vw, 62px); line-height: 1.05; margin-bottom: 20px; font-weight: 800; }
.on-lede { font-size: 17px; line-height: 1.6; color: #334e59; max-width: 560px; margin-bottom: 28px; }

.on-section { max-width: 1200px; margin: 0 auto; padding: 96px 24px; }
.policy-content h3 { font-size: 22px; margin: 32px 0 16px 0; }
.policy-content p { font-size: 16px; line-height: 1.7; margin-bottom: 16px; color: #334e59; }

.on-foot { background: #f4f6f8; border-top: 1px solid #e4eaee; margin-top: 64px; }
.on-foot-inner { max-width: 1200px; margin: 0 auto; padding: 32px 24px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.on-foot-links { display: flex; gap: 20px; font-size: 14px; color: #334e59; }
.on-foot-links a { text-decoration: none; color: inherit; }
.on-foot-links a:hover { color: #0e7c86; }
.on-foot-copy { font-size: 13px; color: #90a2ab; }
`;
