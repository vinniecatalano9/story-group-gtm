import { useState, useEffect } from 'react';

const CLASS_COLORS = {
  interested: 'bg-green-100 text-green-700 border-green-200',
  not_interested: 'bg-red-100 text-red-700 border-red-200',
  why_reach_out: 'bg-blue-100 text-blue-700 border-blue-200',
  more_info: 'bg-blue-100 text-blue-700 border-blue-200',
  cost_question: 'bg-purple-100 text-purple-700 border-purple-200',
  question_other: 'bg-gray-100 text-gray-700 border-gray-200',
  referral: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  re_engage: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  ooo: 'bg-orange-100 text-orange-700 border-orange-200',
  bounce: 'bg-red-100 text-red-700 border-red-200',
  other: 'bg-gray-100 text-gray-700 border-gray-200',
};

const CLASS_EMOJI = {
  interested: '🔥',
  not_interested: '❌',
  why_reach_out: '❓',
  more_info: 'ℹ️',
  cost_question: '💰',
  referral: '🤝',
  ooo: '🌴',
  bounce: '⚠️',
  other: '💬',
};

function ReplyCard({ reply }) {
  const cls = reply.classification || 'other';
  const colors = CLASS_COLORS[cls] || CLASS_COLORS.other;
  const emoji = CLASS_EMOJI[cls] || '💬';
  const time = reply.created_at?.toDate?.()
    ? reply.created_at.toDate().toLocaleString()
    : new Date(reply.created_at).toLocaleString();

  return (
    <div className={`bg-white rounded-xl shadow-sm border ${colors.split(' ')[2] || 'border-gray-100'} p-5 space-y-3`}>
      <div className="flex items-start justify-between">
        <div>
          <span className="text-lg mr-2">{emoji}</span>
          <span className="font-semibold text-gray-900">{reply.email}</span>
          <span className={`ml-2 inline-block px-2 py-0.5 rounded-full text-xs font-medium ${colors}`}>
            {cls.replace(/_/g, ' ')}
          </span>
        </div>
        <span className="text-xs text-gray-400">{time}</span>
      </div>

      <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3 italic">
        "{reply.reply_text?.substring(0, 300)}{reply.reply_text?.length > 300 ? '...' : ''}"
      </p>

      {reply.summary && (
        <p className="text-sm text-gray-600">
          <span className="font-medium">Summary:</span> {reply.summary}
        </p>
      )}

      {reply.draft_response && (
        <div className="text-sm">
          <span className="font-medium text-gray-600">Suggested Reply:</span>
          <p className="mt-1 bg-blue-50 rounded-lg p-3 text-blue-800">{reply.draft_response}</p>
        </div>
      )}

      {reply.suggested_macro && reply.suggested_macro !== 'NONE' && (
        <p className="text-xs text-gray-500">
          Macro: <span className="font-mono bg-gray-100 px-1.5 py-0.5 rounded">{reply.suggested_macro}</span>
        </p>
      )}
    </div>
  );
}

export default function Replies({ api }) {
  const [replies, setReplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filter) params.set('classification', filter);
    params.set('limit', '50');

    fetch(`${api}/api/replies?${params}`)
      .then(r => r.json())
      .then(d => { setReplies(d.replies || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [api, filter]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Replies</h1>
        <select
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm"
        >
          <option value="">All Classifications</option>
          {Object.keys(CLASS_COLORS).map(c => (
            <option key={c} value={c}>{CLASS_EMOJI[c] || ''} {c.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="text-gray-400 py-10 text-center">Loading...</p>
      ) : replies.length === 0 ? (
        <p className="text-gray-400 py-10 text-center">No replies yet</p>
      ) : (
        <div className="space-y-4">
          {replies.map(r => <ReplyCard key={r.id} reply={r} />)}
        </div>
      )}
    </div>
  );
}
