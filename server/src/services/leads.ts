import type { Tx } from '../db/prisma.js';
import type { Actor } from '../auth/scope.js';
import type { FollowUpSlot } from '../lib/vocab.js';

/**
 * Lead bookkeeping that used to be trigger work.
 *
 * Both functions RECOMPUTE rather than adjust. The triggers they replace kept running totals
 * by applying deltas, which drift permanently the moment one is missed or applied twice —
 * and carried GREATEST(x, 0) clamps to hide the symptom when they did. Recomputation is
 * idempotent and repairs existing drift on the next write.
 */

/**
 * Rebuilds each user's assigned-lead counter from the leads themselves.
 *
 * Called with every user a change could have affected — on a reassignment that is both the
 * old and the new owner, since the old one's count drops.
 */
export async function recountAssignedLeads(tx: Tx, userIds: string[]): Promise<void> {
  for (const id of new Set(userIds)) {
    const assignedLeadsCount = await tx.lead.count({
      where: { assignedCallerId: id, deletedAt: null },
    });
    await tx.user.update({ where: { id }, data: { assignedLeadsCount } });
  }
}

/**
 * Records a reassignment in the lead's assignment history, and keeps the follow-ups hanging
 * off that lead pointing at whoever now owns it.
 *
 * The follow-up cascade matters: a follow-up's caller is what scopes it, so leaving it
 * behind would hide the work from the lead's new owner and keep it visible to someone who no
 * longer has the lead.
 */
export async function recordAssignment(
  tx: Tx,
  actor: Actor,
  leadId: string,
  from: string | null,
  to: string | null,
): Promise<void> {
  if (from === to) return;

  if (from) {
    await tx.leadAssignment.updateMany({
      where: { leadId, callerId: from, unassignedAt: null },
      data: { unassignedAt: new Date() },
    });
  }
  if (to) {
    await tx.leadAssignment.create({
      data: { leadId, callerId: to, assignedBy: actor.userId },
    });
  }
  await tx.followUp.updateMany({
    where: { leadId, deletedAt: null },
    data: { assignedCallerId: to },
  });
}

/**
 * Rebuilds a lead's nextFollowUpAt from the follow-ups actually scheduled for it.
 *
 * The column is a denormalised copy of "the earliest pending follow-up", and is what the
 * leads list renders under NEXT FOLLOW-UP. Nothing maintained it in either direction:
 * scheduling a follow-up left the column untouched, and writing the column created no
 * follow-up. So a lead could advertise a date the calendar knew nothing about — which is
 * exactly what it did.
 *
 * Recomputed from the follow-ups rather than written alongside them, for the reason at the
 * top of this file: a derived value maintained in two places eventually disagrees with
 * itself, and this repairs whatever it finds.
 */
export async function syncNextFollowUp(tx: Tx, leadId: string): Promise<void> {
  const next = await tx.followUp.findFirst({
    where: { leadId, deletedAt: null, status: 'pending' },
    orderBy: { scheduledAt: 'asc' },
    select: { scheduledAt: true },
  });
  await tx.lead.update({
    where: { id: leadId },
    data: { nextFollowUpAt: next?.scheduledAt ?? null },
  });
}

/**
 * Points a lead's pending follow-up at `when`, creating or retiring one as needed.
 *
 * This is what the lead form's "Next Follow-up" field does now. Writing the column alone
 * scheduled nothing, so the task never reached the calendar or the lead's own page.
 */
export async function scheduleNextFollowUp(
  tx: Tx,
  actor: Actor,
  lead: { id: string; customerId: string | null; customerName: string; assignedCallerId: string | null },
  when: Date | null,
  /** The part of the day agreed with the customer, or null when none was. */
  slot: FollowUpSlot | null = null,
): Promise<void> {
  const existing = await tx.followUp.findFirst({
    where: { leadId: lead.id, deletedAt: null, status: 'pending' },
    orderBy: { scheduledAt: 'asc' },
    select: { id: true },
  });

  if (when) {
    if (existing) {
      await tx.followUp.update({ where: { id: existing.id }, data: { scheduledAt: when, slot } });
    } else {
      await tx.followUp.create({
        data: {
          leadId: lead.id,
          customerId: lead.customerId,
          customerName: lead.customerName,
          scheduledAt: when,
          slot,
          // The form offers a date and a slot, so this matches the default used when a
          // follow-up is created explicitly without a type.
          type: 'call',
          status: 'pending',
          assignedCallerId: lead.assignedCallerId,
          createdBy: actor.userId,
        },
      });
    }
  } else if (existing) {
    // Clearing the date retires the task rather than deleting it, so one that was scheduled
    // and then called off still exists to be found.
    await tx.followUp.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
  }

  await syncNextFollowUp(tx, lead.id);
}
