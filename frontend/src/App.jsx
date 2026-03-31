import { Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Leads from './pages/Leads';
import Replies from './pages/Replies';
import LinkedInReplies from './pages/LinkedInReplies';
import Scrapers from './pages/Scrapers';
import LeadCleaner from './pages/LeadCleaner';
import Transcripts from './pages/Transcripts';

const API = import.meta.env.VITE_API_URL || '';

function Nav() {
  const link = (to, label) => (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200 ${
          isActive
            ? 'bg-brand-500/20 text-white border border-brand-500/30 shadow-[0_0_12px_rgba(24,86,255,0.15)]'
            : 'text-white/50 hover:text-white/80 hover:bg-white/5'
        }`
      }
    >
      {label}
    </NavLink>
  );

  return (
    <nav className="glass-nav sticky top-0 z-50 px-6 py-3 flex items-center gap-2">
      <span className="font-bold text-lg mr-6">
        <span className="text-brand-400">Story</span>
        <span className="text-white/40 ml-1">Group</span>
        <span className="text-white/20 text-xs ml-2 font-normal tracking-wider uppercase">GTM</span>
      </span>
      {link('/', 'Dashboard')}
      {link('/leads', 'Leads')}
      {link('/replies', 'Email Replies')}
      {link('/linkedin', 'LinkedIn')}
      {link('/scrapers', 'Scrapers')}
      {link('/transcripts', 'Transcripts')}
      {link('/cleaner', 'Lead Cleaner')}
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
        </Routes>
      </main>
    </div>
  );
}
