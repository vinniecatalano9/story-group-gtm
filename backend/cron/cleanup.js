const instantly = require('../services/instantly');
const { addLog } = require('../services/db');
const { notifyCleanup } = require('../services/slack');

/**
 * Weekly cleanup — remove stale leads from Instantly.
 * Runs Sunday 11pm.
 * Targets: completed sequence + no reply, excluding hot statuses.
 */
async function runCleanup() {
  console.log('[cleanup] Starting weekly Instantly cleanup...');
  const maxDeletions = parseInt(process.env.MAX_CLEANUP_PER_RUN) || 500;

  try {
    const campaigns = await instantly.getCampaigns();
    if (!campaigns?.length) {
      console.log('[cleanup] No campaigns found');
      return;
    }

    let totalDeleted = 0;
    let campaignsAffected = 0;
    const SKIP_STATUSES = ['Meeting Booked', 'Call Time Sent', 'Objection Follow Up', 'Interested'];

    for (const campaign of campaigns) {
      if (totalDeleted >= maxDeletions) break;

      try {
        const result = await instantly.getCampaignLeads(campaign.id, {
          status: 'completed',
          limit: 500,
        });

        const leads = result?.leads || [];
        if (!leads.length) continue;

        // Filter: completed + no reply + not in protected statuses
        const toDelete = leads
          .filter(l => !l.replied && !SKIP_STATUSES.includes(l.status))
          .map(l => l.email)
          .slice(0, maxDeletions - totalDeleted);

        if (toDelete.length > 0) {
          await instantly.removeLeads(toDelete, campaign.id);
          totalDeleted += toDelete.length;
          campaignsAffected++;
          console.log(`[cleanup] Deleted ${toDelete.length} from campaign ${campaign.name || campaign.id}`);
        }
      } catch (e) {
        console.error(`[cleanup] Error processing campaign ${campaign.id}:`, e.message);
      }
    }

    await addLog('cleanup', { totalDeleted, campaignsAffected });
    await notifyCleanup({ totalDeleted, campaigns: campaignsAffected });

    console.log(`[cleanup] Done — ${totalDeleted} leads removed from ${campaignsAffected} campaigns`);
  } catch (e) {
    console.error('[cleanup] Error:', e);
  }
}

module.exports = { runCleanup };
