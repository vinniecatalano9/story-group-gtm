const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID,
});

const db = admin.firestore();

// Collections
const leads = db.collection('leads');
const replies = db.collection('replies');
const logs = db.collection('logs');

async function addLead(lead) {
  const ref = leads.doc(lead.lead_id);
  await ref.set({ ...lead, created_at: new Date(), updated_at: new Date() });
  return ref.id;
}

async function updateLead(leadId, data) {
  await leads.doc(leadId).update({ ...data, updated_at: new Date() });
}

async function getLeadByEmail(email) {
  const snap = await leads.where('email', '==', email.toLowerCase()).limit(1).get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function getLeadsByStatus(status, limit = 50) {
  const snap = await leads.where('status', '==', status).limit(limit).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function addReply(reply) {
  const ref = await replies.add({ ...reply, created_at: new Date() });
  return ref.id;
}

async function addLog(type, data) {
  await logs.add({ type, data, created_at: new Date() });
}

async function getLeadStats() {
  const statuses = ['ingested', 'enriched', 'scored', 'emailed', 'replied', 'booked', 'dead'];
  const stats = {};
  for (const s of statuses) {
    const snap = await leads.where('status', '==', s).count().get();
    stats[s] = snap.data().count;
  }
  return stats;
}

async function getLeadsPage({ status, tier, limit = 50, startAfter } = {}) {
  let q = leads.orderBy('created_at', 'desc');
  if (status) q = q.where('status', '==', status);
  if (tier) q = q.where('tier', '==', tier);
  if (startAfter) q = q.startAfter(startAfter);
  q = q.limit(limit);
  const snap = await q.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getRepliesPage({ classification, limit = 50, startAfter } = {}) {
  let q = replies.orderBy('created_at', 'desc');
  if (classification) q = q.where('classification', '==', classification);
  if (startAfter) q = q.startAfter(startAfter);
  q = q.limit(limit);
  const snap = await q.get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

module.exports = {
  db, leads, replies, logs,
  addLead, updateLead, getLeadByEmail, getLeadsByStatus,
  addReply, addLog, getLeadStats, getLeadsPage, getRepliesPage,
};
