import { Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Leads from './pages/Leads';
import Replies from './pages/Replies';
import LinkedInReplies from './pages/LinkedInReplies';
import Scrapers from './pages/Scrapers';
import LeadCleaner from './pages/LeadCleaner';
import Transcripts from './pages/Transcripts';
import Tracker from './pages/Tracker';
import Command from './pages/Command';

const API = import.meta.env.VITE_API_URL || '';

function Nav() {
  const link = (to, label) => (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 ${
          isActive
            ? 'bg-brand-500/20 text-white border border-brand-500/30 shadow-[0_0_12px_rgba(255,34,87,0.2)]'
            : 'text-white/50 hover:text-white/80 hover:bg-white/5'
        }`
      }
    >
      {label}
    </NavLink>
  );

  return (
    <nav className="glass-nav sticky top-0 z-50 px-6 py-3 flex items-center gap-2">
      <NavLink to="/" className="mr-6 flex items-baseline gap-1.5 hover:opacity-90 transition-opacity" title="Back to Coaching Snapshot">
        <span className="font-serif italic font-bold text-xl text-brand-500 leading-none">story</span>
        <span className="text-muted text-base font-medium">group</span>
        <span className="text-muted/70 text-[10px] ml-2 font-semibold tracking-[0.14em] uppercase">GTM</span>
      </NavLink>
      {link('/', 'Dashboard')}
      {link('/command', 'Command')}
      {/* {link('/leads', 'Leads')} */}
      {link('/replies', 'Email Replies')}
      {link('/linkedin', 'LinkedIn')}
      {/* {link('/scrapers', 'Scrapers')} */}
      {link('/transcripts', 'Transcripts')}
      {link('/cleaner', 'Email Cleaner')}
      {link('/tracker', 'Tracker')}
      <a
        href="/pr-mastery/"
        className="px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 text-white/50 hover:text-white/80 hover:bg-white/5"
      >
        PR Mastery
      </a>
      <a
        href="/lead-filter/"
        className="px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 text-white/50 hover:text-white/80 hover:bg-white/5"
      >
        LinkedIn Lead List Filter
      </a>
    </nav>
  );
}

export default function App() {
  return (
    <div className="min-h-screen">
      <Nav />
      <main className="max-w-7xl mx-auto px-6 py-6">
        <Routes>
          <Route path="/" element={<Dashboard api={API} />} />
          <Route path="/leads" element={<Leads api={API} />} />
          <Route path="/replies" element={<Replies api={API} />} />
          <Route path="/linkedin" element={<LinkedInReplies api={API} />} />
          <Route path="/scrapers" element={<Scrapers api={API} />} />
          <Route path="/transcripts" element={<Transcripts api={API} />} />
          <Route path="/cleaner" element={<LeadCleaner api={API} />} />
          <Route path="/tracker" element={<Tracker />} />
          <Route path="/command" element={<Command api={API} />} />
        </Routes>
      </main>
    </div>
  );
}
