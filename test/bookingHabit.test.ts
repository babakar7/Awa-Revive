import { describe, expect, it } from "vitest";
import { computeBookingHabit } from "../src/domain/repo.js";

// Dakar == UTC. 2026-07-17 is a Friday; 2026-07-10 a Friday; 2026-07-15 a Wednesday.
const FUSION = "svc_fusion";
const YOGA = "svc_yoga";

describe("computeBookingHabit", () => {
  it("returns null with no bookings", () => {
    expect(computeBookingHabit([])).toBeNull();
  });

  it("returns null when nothing repeats (all singletons)", () => {
    const rows = [
      { service_id: FUSION, service_name: "Pilates Fusion", slot_start: "2026-07-17T10:00:00Z" },
      { service_id: YOGA, service_name: "Yoga", slot_start: "2026-07-15T18:00:00Z" },
    ];
    expect(computeBookingHabit(rows)).toBeNull();
  });

  it("detects the recurring class + weekday + time booked at least twice", () => {
    const rows = [
      { service_id: FUSION, service_name: "Pilates Fusion", slot_start: "2026-07-24T10:00:00Z" }, // Fri 10:00
      { service_id: FUSION, service_name: "Pilates Fusion", slot_start: "2026-07-17T10:00:00Z" }, // Fri 10:00
      { service_id: YOGA, service_name: "Yoga", slot_start: "2026-07-15T18:00:00Z" }, // Wed 18:00 once
    ];
    const habit = computeBookingHabit(rows);
    expect(habit).not.toBeNull();
    expect(habit!.service_id).toBe(FUSION);
    expect(habit!.weekday).toBe(5); // Friday
    expect(habit!.hour).toBe(10);
    expect(habit!.minute).toBe(0);
    expect(habit!.occurrences).toBe(2);
  });

  it("does not merge different times of the same class", () => {
    const rows = [
      { service_id: FUSION, service_name: "Pilates Fusion", slot_start: "2026-07-17T10:00:00Z" }, // Fri 10:00
      { service_id: FUSION, service_name: "Pilates Fusion", slot_start: "2026-07-24T18:00:00Z" }, // Fri 18:00
    ];
    expect(computeBookingHabit(rows)).toBeNull(); // each pattern appears once
  });

  it("picks the most frequent pattern when several qualify", () => {
    const rows = [
      { service_id: YOGA, service_name: "Yoga", slot_start: "2026-07-15T18:00:00Z" }, // Wed 18:00
      { service_id: YOGA, service_name: "Yoga", slot_start: "2026-07-08T18:00:00Z" }, // Wed 18:00
      { service_id: YOGA, service_name: "Yoga", slot_start: "2026-07-01T18:00:00Z" }, // Wed 18:00 (x3)
      { service_id: FUSION, service_name: "Pilates Fusion", slot_start: "2026-07-17T10:00:00Z" }, // Fri 10:00
      { service_id: FUSION, service_name: "Pilates Fusion", slot_start: "2026-07-10T10:00:00Z" }, // Fri 10:00 (x2)
    ];
    const habit = computeBookingHabit(rows);
    expect(habit!.service_id).toBe(YOGA);
    expect(habit!.occurrences).toBe(3);
  });
});
