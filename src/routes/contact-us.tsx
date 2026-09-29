import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/contact-us")({
  head: () => ({
    meta: [
      { title: "CuraQ | Contact Us" },
      { name: "description", content: "Get in touch with the CuraQ team." },
    ],
  }),
  component: ContactUs,
});

function ContactUs() {
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
            <h1>Contact Us</h1>
            <p className="on-lede" style={{ margin: '0 auto' }}>
              We're here to help you study smarter. Reach out to us if you need anything!
            </p>
          </div>
        </div>
      </section>

      <section className="on-section" style={{ paddingTop: '40px', maxWidth: '800px', margin: '0 auto' }}>
        <div className="policy-content" style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>

          <div style={{ background: '#ffffff', padding: '32px', borderRadius: '16px', border: '1px solid #dbe3e7', boxShadow: '0 12px 32px -12px rgba(10,61,74,0.1)' }}>
            <h3 style={{ margin: '0 0 16px 0' }}>💬 WhatsApp</h3>
            <p>
              For immediate assistance, questions about billing, or quick support, you can reach out to us directly on WhatsApp. We typically respond within a few hours.
            </p>
            <p style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#0e7c86', marginTop: '16px' }}>
              +0000000000
            </p>
            <a href="https://wa.me/00000000" target="_blank" rel="noopener noreferrer" className="on-btn on-btn-primary" style={{ marginTop: '16px' }}>
              Message us on WhatsApp
            </a>
          </div>

          <div style={{ background: '#ffffff', padding: '32px', borderRadius: '16px', border: '1px solid #dbe3e7', boxShadow: '0 12px 32px -12px rgba(10,61,74,0.1)' }}>
            <h3 style={{ margin: '0 0 16px 0' }}>🎫 Support Tickets</h3>
            <p>
              If you have an account, the best way to get help with specific features or account issues is to open a support ticket directly from your dashboard. Our team will review your request and get back to you promptly.
            </p>
            <a href="/app/index.html" className="on-btn on-btn-outline" style={{ marginTop: '16px' }}>
              Open a Support Ticket in App
            </a>
          </div>

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
.on-btn-primary { background: #0e7c86; color: #ffffff; }
.on-btn-primary:hover { background: #0b6770; }
.on-btn-ghost { background: transparent; color: #0a3d4a; }
.on-btn-ghost:hover { background: #eef4f5; }
.on-btn-outline { background: #ffffff; color: #0a3d4a; border-color: #dbe3e7; }
.on-btn-outline:hover { border-color: #0e7c86; color: #0e7c86; }

.on-hero { padding: 72px 24px 88px; background: linear-gradient(180deg, #ffffff 0%, #f4f6f8 100%); border-bottom: 1px solid #eef2f4; }
.on-hero-inner { max-width: 1200px; margin: 0 auto; display: grid; }
.on-hero-copy h1 { font-size: clamp(38px, 5.6vw, 62px); line-height: 1.05; margin-bottom: 20px; font-weight: 800; }
.on-lede { font-size: 17px; line-height: 1.6; color: #334e59; max-width: 560px; margin-bottom: 28px; }

.on-section { max-width: 1200px; margin: 0 auto; padding: 96px 24px; }
.policy-content h3 { font-size: 22px; }
.policy-content p { font-size: 16px; line-height: 1.7; margin-bottom: 0; color: #334e59; }

.on-foot { background: #f4f6f8; border-top: 1px solid #e4eaee; margin-top: 64px; }
.on-foot-inner { max-width: 1200px; margin: 0 auto; padding: 32px 24px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.on-foot-links { display: flex; gap: 20px; font-size: 14px; color: #334e59; }
.on-foot-links a { text-decoration: none; color: inherit; }
.on-foot-links a:hover { color: #0e7c86; }
.on-foot-copy { font-size: 13px; color: #90a2ab; }
`;
