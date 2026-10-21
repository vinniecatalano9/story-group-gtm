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
  let skip = 0;
  const batchSize = 50;
  while (true) {
    // skip must be inlined — Fireflies doesn't accept it as a GraphQL variable
    const data = await graphql(`
      {
        transcripts(limit: ${batchSize}, skip: ${skip}) {
          id title date duration transcript_url participants
          summary { overview action_items keywords }
        }
      }
    `);
    const batch = data.transcripts || [];
    all.push(...batch);
    console.log(`[fireflies] Fetched ${batch.length} transcripts (skip ${skip}, total ${all.length})`);
    if (batch.length < batchSize) break;
    skip += batchSize;
  }
  return all;
}

/**
 * Hand Fireflies an audio URL to transcribe (used for RingCentral phone calls).
 * bearerToken is sent as the download auth so the URL itself carries no secret.
 * The transcript lands in the normal Fireflies list, so the webhook/poll picks it up.
 */
async function uploadAudio({ url, title, attendees = [], meetingDate = null, clientReferenceId = null, bearerToken = null }) {
  const data = await graphql(`
    mutation UploadAudio($input: AudioUploadInput) {
      uploadAudio(input: $input) { success title message }
    }
  `, {
    input: {
      url,
      title,
      attendees,
      ...(meetingDate ? { meeting_date: meetingDate } : {}),
      ...(clientReferenceId ? { client_reference_id: clientReferenceId } : {}),
      ...(bearerToken ? { download_auth: { type: 'bearer_token', bearer: { token: bearerToken } } } : {}),
    },
  });
  return data.uploadAudio;
}

module.exports = { getTranscript, getRecentTranscripts, getAllTranscripts, uploadAudio, graphql };
