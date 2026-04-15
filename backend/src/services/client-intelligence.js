import { supabase } from '../config.js';
import logger from '../lib/logger.js';

/**
 * Client Intelligence Service
 *
 * Populates the client_intelligence table with calculated metrics:
 * - total_visits, total_spent, avg_booking_gap_days
 * - favourite_treatment, last_visit, lifetime_value
 * - churn_risk, next_predicted_visit
 */

/**
 * Update client intelligence for a single client.
 * Calculates metrics and upserts into client_intelligence table.
 */
export async function updateClientIntelligence(beauticianId, clientId) {
  try {
    // 1. Get all completed appointments for this client
    const { data: appointments, error: aptError } = await supabase
      .from('appointments')
      .select('id, starts_at, ends_at, treatment_id, price_cents, status')
      .eq('beautician_id', beauticianId)
      .eq('client_id', clientId)
      .eq('status', 'completed')
      .order('starts_at', { ascending: true });

    if (aptError) {
      logger.error({ err: aptError, clientId }, 'Failed to fetch appointments for intelligence');
      return null;
    }

    if (!appointments || appointments.length === 0) {
      // No completed appointments yet — clear or set default intelligence
      await supabase
        .from('client_intelligence')
        .upsert({
          client_id: clientId,
          beautician_id: beauticianId,
          rebooking_rhythm_days: null,
          rebooking_consistency: 0,
          favourite_treatments: [],
          avg_spend_cents: 0,
          updated_at: new Date().toISOString()
        }, { onConflict: 'client_id,beautician_id' });

      return null;
    }

    // 2. Calculate metrics
    const completedCount = appointments.length;
    const totalSpent = appointments.reduce((sum, apt) => sum + (apt.price_cents || 0), 0);
    const avgSpend = Math.round(totalSpent / completedCount);

    // 3. Calculate booking gaps (days between appointments)
    const gaps = [];
    for (let i = 1; i < appointments.length; i++) {
      const prev = new Date(appointments[i - 1].ends_at);
      const curr = new Date(appointments[i].starts_at);
      const gapMs = curr.getTime() - prev.getTime();
      const gapDays = Math.round(gapMs / (1000 * 60 * 60 * 24));
      gaps.push(gapDays);
    }

    const avgBookingGap = gaps.length > 0
      ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)
      : null;

    // 4. Calculate consistency (standard deviation of gaps as proportion of mean)
    let consistency = 0;
    if (gaps.length > 1) {
      const mean = avgBookingGap;
      const variance = gaps.reduce((sum, gap) => sum + Math.pow(gap - mean, 2), 0) / gaps.length;
      const stdDev = Math.sqrt(variance);
      // High consistency = low stdDev. Scale 0-1 where 1 is perfect consistency
      consistency = Math.max(0, Math.min(1, 1 - (stdDev / (mean || 1) / 2)));
    }

    // 5. Find favourite treatment (most frequently booked)
    const treatmentCounts = {};
    let favouriteTreatmentId = null;
    let maxCount = 0;

    for (const apt of appointments) {
      const tid = apt.treatment_id;
      treatmentCounts[tid] = (treatmentCounts[tid] || 0) + 1;
      if (treatmentCounts[tid] > maxCount) {
        maxCount = treatmentCounts[tid];
        favouriteTreatmentId = tid;
      }
    }

    const favouriteTreatments = favouriteTreatmentId ? [favouriteTreatmentId] : [];

    // 6. Last visit date
    const lastVisitDate = new Date(appointments[appointments.length - 1].ends_at);
    const lastVisitStr = lastVisitDate.toISOString().split('T')[0]; // YYYY-MM-DD

    // 7. Churn risk based on gap vs average
    let churnRisk = 'low';
    if (avgBookingGap && gaps.length > 0) {
      const mostRecentGap = gaps[gaps.length - 1];
      if (mostRecentGap > avgBookingGap * 2) {
        churnRisk = 'high';
      } else if (mostRecentGap > avgBookingGap * 1.5) {
        churnRisk = 'medium';
      }
    }

    // 8. Next predicted visit (last_visit + average gap)
    let nextPredictedVisit = null;
    if (avgBookingGap) {
      const nextDate = new Date(lastVisitDate);
      nextDate.setDate(nextDate.getDate() + avgBookingGap);
      nextPredictedVisit = nextDate.toISOString().split('T')[0]; // YYYY-MM-DD
    }

    // 9. Lifetime value = total spent
    const lifetimeValue = totalSpent;

    // Upsert into client_intelligence
    const { error: upsertError } = await supabase
      .from('client_intelligence')
      .upsert({
        client_id: clientId,
        beautician_id: beauticianId,
        rebooking_rhythm_days: avgBookingGap,
        rebooking_consistency: consistency,
        favourite_treatments: favouriteTreatments,
        avg_spend_cents: avgSpend,
        price_sensitivity: avgSpend < 2000 ? 'high' : avgSpend < 4000 ? 'normal' : 'low',
        updated_at: new Date().toISOString()
      }, { onConflict: 'client_id,beautician_id' });

    if (upsertError) {
      logger.error({ err: upsertError, clientId }, 'Failed to upsert client intelligence');
      return null;
    }

    logger.info({
      clientId,
      totalVisits: completedCount,
      totalSpent,
      avgGap: avgBookingGap,
      churnRisk
    }, 'Updated client intelligence');

    return {
      total_visits: completedCount,
      total_spent: totalSpent,
      avg_booking_gap_days: avgBookingGap,
      favourite_treatment: favouriteTreatmentId,
      last_visit: lastVisitStr,
      lifetime_value: lifetimeValue,
      churn_risk: churnRisk,
      next_predicted_visit: nextPredictedVisit
    };

  } catch (err) {
    logger.error({ err, clientId }, 'Error in updateClientIntelligence');
    return null;
  }
}

/**
 * Refresh intelligence for all clients of a beautician.
 * Runs updateClientIntelligence for each client.
 * Returns { count, completed }.
 */
export async function refreshAllIntelligence(beauticianId) {
  try {
    // Get all clients for this beautician
    const { data: clients, error: clientError } = await supabase
      .from('clients')
      .select('id')
      .eq('beautician_id', beauticianId);

    if (clientError) {
      logger.error({ err: clientError }, 'Failed to fetch clients for refresh');
      return { count: 0, completed: 0 };
    }

    if (!clients || clients.length === 0) {
      return { count: 0, completed: 0 };
    }

    let completed = 0;

    // Update intelligence for each client sequentially
    for (const client of clients) {
      const result = await updateClientIntelligence(beauticianId, client.id);
      if (result) completed++;
    }

    logger.info({
      beauticianId,
      totalClients: clients.length,
      completedCount: completed
    }, 'Refreshed all client intelligence');

    return {
      count: clients.length,
      completed
    };

  } catch (err) {
    logger.error({ err }, 'Error in refreshAllIntelligence');
    return { count: 0, completed: 0 };
  }
}
