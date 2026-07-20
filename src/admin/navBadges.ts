import * as links from "../domain/linkRequests.js";
import * as reviews from "../domain/conversationReview.js";
import * as delivery from "../domain/deliveryRepo.js";
import { pool } from "../db/index.js";

/**
 * Cheap counts for the admin sidebar + inbox total. Soft-fails to 0 so chrome
 * never 500s the whole admin if one source is down.
 */
export interface NavBadges {
  refunds: number;
  plans: number;
  handoffs: number;
  reviews: number;
  followUps: number;
  crmLinks: number;
  livraisons: number;
  /** Sum used on « À faire ». */
  total: number;
}

const empty: NavBadges = {
  refunds: 0,
  plans: 0,
  handoffs: 0,
  reviews: 0,
  followUps: 0,
  crmLinks: 0,
  livraisons: 0,
  total: 0,
};

async function soft<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

export async function loadNavBadges(): Promise<NavBadges> {
  const [money, handoffs, reviewN, crmLinks, livraisons] = await Promise.all([
    soft(
      pool
        .query(
          `select
             (select count(*) from pending_bookings where status = 'REFUND_NEEDED')::int as refunds,
             (select count(*) from pending_plan_orders where status = 'PAID')::int as plans`,
        )
        .then((r) => ({
          refunds: r.rows[0]?.refunds ?? 0,
          plans: r.rows[0]?.plans ?? 0,
        })),
      { refunds: 0, plans: 0 },
    ),
    soft(
      pool
        .query(`select count(*)::int as n from handoffs where status = 'OPEN'`)
        .then((r) => r.rows[0]?.n ?? 0),
      0,
    ),
    soft(reviews.openReviews().then((r) => r.length), 0),
    soft(links.receptionQueue().then((q) => q.length), 0),
    soft(
      delivery.listOpenDeliveryOrders().then((orders) => {
        const now = Date.now();
        return orders.filter((o) => {
          if (o.status === "IN_KITCHEN" && o.kitchen_notify_status === "failed") return true;
          if (o.status === "IN_KITCHEN" && o.alerted_at) return true;
          if (o.status === "IN_KITCHEN") {
            const slaMs = (o.sla_minutes ?? 20) * 60_000;
            if (now - new Date(o.created_at).getTime() >= slaMs) return true;
          }
          if (o.status === "READY" && o.client_notify_status === "failed") return true;
          return false;
        }).length;
      }),
      0,
    ),
  ]);

  const badges: NavBadges = {
    refunds: money.refunds,
    plans: money.plans,
    handoffs,
    reviews: reviewN,
    followUps: handoffs + reviewN,
    crmLinks,
    livraisons,
    total: 0,
  };
  badges.total =
    badges.refunds +
    badges.plans +
    badges.handoffs +
    badges.reviews +
    badges.crmLinks +
    badges.livraisons;
  return badges;
}

export { empty as emptyNavBadges };
