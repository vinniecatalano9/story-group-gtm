const admin = require('firebase-admin');
const path = require('path');

const credPath = path.join(__dirname, 'firebase-service-account.json');
admin.initializeApp({ credential: admin.credential.cert(require(credPath)) });
const db = admin.firestore();

async function resetAll() {
  const snap = await db.collection('leads').get();
  let count = 0;
  const batches = [];
  let batch = db.batch();
  let batchCount = 0;
  
  snap.forEach(doc => {
    batch.update(doc.ref, {
      status: 'ingested',
      email: '',
      phone: '',
      first_name: '',
      last_name: '',
      role_title: '',
      linkedin_url: '',
      score: 0,
      tier: '',
      signal_type: '',
      signal_strength: '',
      signal_summary: '',
      company_description: '',
      detected_industry: '',
      enriched_at: '',
      hubspot_contact_id: '',
      error: '',
    });
    count++;
    batchCount++;
    if (batchCount >= 400) {
      batches.push(batch);
      batch = db.batch();
      batchCount = 0;
    }
  });
  if (batchCount > 0) batches.push(batch);
  
  for (const b of batches) await b.commit();
  console.log(`Reset ${count} leads to ingested`);
}

resetAll().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
