import { Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Leads from './pages/Leads';
import Replies from './pages/Replies';
import Scrapers from './pages/Scrapers';

const API = import.meta.env.VITE_API_URL || '';

function Nav() {
  const link = (to, label) => (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
          isActive ? 'bg-brand-600 text-white' : 'text-gray-600 hover:bg-gray-100'
        }`
      }
    >
      {label}
    </NavLink>
  );

  return (
    <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-2">
      <span className="font-bold text-lg text-brand-700 mr-6">Story Group GTM</span>
      {link('/', 'Dashboard')}
      {link('/leads', 'Leads')}
      {link('/replies', 'Replies')}
      {link('/scrapers', 'Scrapers')}
    </nav>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Nav />
      <main className="max-w-7xl mx-auto px-6 py-6">
        <Routes>
          <Route path="/" element={<Dashboard api={API} />} />
          <Route path="/leads" element={<Leads api={API} />} />
          <Route path="/replies" element={<Replies api={API} />} />
          <Route path="/scrapers" element={<Scrapers api={API} />} />
        </Routes>
      </main>
    </div>
  );
}
