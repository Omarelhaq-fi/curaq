import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/refund-policy")({
  head: () => ({
    meta: [
      { title: "CuraQ | Refund Policy" },
      { name: "description", content: "Refund policy for CuraQ." },
    ],
  }),
  component: RefundPolicy,
});

function RefundPolicy() {
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
            <h1>Refund Policy</h1>
            <p className="on-lede" style={{ margin: '0 auto' }}>
              CuraQ is 100% free to use. All financial contributions are considered voluntary donations.
            </p>
          </div>
        </div>
      </section>

      <section className="on-section" style={{ paddingTop: '40px', maxWidth: '800px', margin: '0 auto' }}>
        <div className="policy-content">
          <p><strong>Effective Date:</strong> August 2026</p>
          
          <h3>1. Core Policy: No Refunds</h3>
          <p>
            CuraQ provides its entire suite of tools (including AI features, spaced repetition flashcards, and exam-style MCQs) completely free of charge. We do not lock features behind paywalls or require premium subscriptions. 
          </p>
          <p>
            Because our services are fully accessible at no cost, any financial support provided by users is classified strictly as a <strong>voluntary donation</strong>. As such, <strong>all donations are final and non-refundable</strong>.
          </p>

          <h3>2. Purpose of Donations</h3>
          <p>
            The funds we receive from our generous community are used directly to keep our servers running, cover API and infrastructure costs, and support the ongoing development of new features. By donating, you are helping ensure that CuraQ remains free and accessible to medical and university students around the world.
          </p>

          <h3>3. Accidental or Duplicate Donations</h3>
          <p>
            While our standard policy is that all donations are final, we understand that technical errors can occur. If you believe you have accidentally submitted a duplicate donation due to a technical glitch or payment gateway error, please contact our support team within <strong>7 days</strong> of the transaction. We will review such cases individually, but we reserve the right to decline refund requests that do not strictly stem from a verifiable technical error.
          </p>

          <h3>4. Cancellation of Recurring Donations</h3>
          <p>
            If you have opted into any form of recurring donation (if available), you may cancel your upcoming contributions at any time through your payment provider or account dashboard. Cancellation will apply to future charges; however, previously processed donations will remain non-refundable.
          </p>

          <h3>5. Contact Us</h3>
          <p>
            If you need to contact us, please log in to your account and open a support ticket from your dashboard.
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
