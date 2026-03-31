const API_BASE = 'https://api.fireflies.ai/graphql';
const API_KEY = () => process.env.FIREFLIES_API_KEY;

async function graphql(query, variables = {}) {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY()}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Fireflies API ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0]?.message || 'GraphQL error');
  return data.data;
}

async function getTranscript(transcriptId) {
  const data = await graphql(`
    query Transcript($id: String!) {
      transcript(id: $id) {
        id
        title
        date
        duration
        transcript_url
        audio_url
        video_url
        participants
        summary {
          overview
          action_items
          keywords
        }
        sentences {
          speaker_name
          text
        }
      }
    }
  `, { id: transcriptId });
  return data.transcript;
}

async function getRecentTranscripts(limit = 20) {
  const data = await graphql(`
    query RecentTranscripts($limit: Int) {
      transcripts(limit: $limit) {
        id
        title
        date
        duration
        transcript_url
        participants
        summary {
          overview
          action_items
          keywords
        }
      }
    }
  `, { limit: Math.min(limit, 50) });
  return data.transcripts || [];
}

async function getAllTranscripts() {
  const all = [];
  const batchSize = 50;
  let oldestDate = null;
  const seen = new Set();
  while (true) {
    // Fireflies doesn't support skip — paginate by filtering on date
    const vars = { limit: batchSize };
    const dateFilter = oldestDate ? `, date_to: "${oldestDate}"` : '';
    const data = await graphql(`
      query AllTranscripts($limit: Int) {
        transcripts(limit: $limit${dateFilter}) {
          id title date duration transcript_url participants
          summary { overview action_items keywords }
        }
      }
    `, vars);
    const batch = (data.transcripts || []).filter(t => !seen.has(t.id));
    if (batch.length === 0) break;
    for (const t of batch) seen.add(t.id);
    all.push(...batch);
    // Get oldest date from this batch for next page
    const dates = batch.filter(t => t.date).map(t => new Date(t.date).toISOString());
    if (dates.length) oldestDate = dates.sort()[0];
    console.log(`[fireflies] Fetched ${batch.length} transcripts (total ${all.length}, oldest: ${oldestDate})`);
    if (batch.length < batchSize) break;
  }
  return all;
}

module.exports = { getTranscript, getRecentTranscripts, getAllTranscripts, graphql };
