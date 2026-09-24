import { describe, expect, it } from "vitest";
import {
  aggregateIngredients,
  computeMaxTrip,
  materialSlotsUsed,
  maxCrafts,
  scaleFromHave,
  slotsForAmount,
  withdrawAmounts,
} from "./logic";

const steel = [
  { name: "Ore", amountPerCraft: 1 },
  { name: "Coal", amountPerCraft: 3 },
];

describe("slotsForAmount", () => {
  it("ceils by stack size", () => {
    expect(slotsForAmount(25, 25)).toBe(1);
    expect(slotsForAmount(26, 25)).toBe(2);
    expect(slotsForAmount(0, 25)).toBe(0);
    expect(slotsForAmount(75, 25)).toBe(3);
  });

  it("guards zero stack size", () => {
    expect(slotsForAmount(10, 0)).toBe(10);
  });
});

describe("aggregateIngredients", () => {
  it("sums duplicate names case-insensitively", () => {
    expect(
      aggregateIngredients([
        { name: "Ore", amountPerCraft: 1 },
        { name: "ore", amountPerCraft: 1 },
        { name: "Coal", amountPerCraft: 3 },
      ]),
    ).toEqual([
      { name: "Ore", amountPerCraft: 2 },
      { name: "Coal", amountPerCraft: 3 },
    ]);
  });
});

describe("maxCrafts / computeMaxTrip", () => {
  it("matches worked example: 29 slots, 25/stack, reserve 1 → 175", () => {
    const result = computeMaxTrip(steel, 29, 25, 1);
    expect(result.usableSlots).toBe(28);
    expect(result.crafts).toBe(175);
    expect(result.withdraw).toEqual([
      { name: "Ore", amount: 175, slots: 7 },
      { name: "Coal", amount: 525, slots: 21 },
    ]);
    expect(result.materialSlotsUsed).toBe(28);
    expect(result.emptySlots).toBe(0);
  });

  it("rejects 176 crafts for the same config", () => {
    expect(materialSlotsUsed(steel, 176, 25)).toBeGreaterThan(28);
    expect(maxCrafts(steel, 28, 25)).toBe(175);
  });

  it("returns 0 when no usable slots", () => {
    expect(maxCrafts(steel, 0, 25)).toBe(0);
    expect(computeMaxTrip(steel, 1, 25, 1).crafts).toBe(0);
  });

  it("handles single-ingredient recipes", () => {
    const iron = [{ name: "Iron ore", amountPerCraft: 1 }];
    // 28 slots * 25 = 700
    expect(maxCrafts(iron, 28, 25)).toBe(700);
  });
});

describe("withdrawAmounts", () => {
  it("scales by crafts", () => {
    expect(withdrawAmounts(steel, 10, 25)).toEqual([
      { name: "Ore", amount: 10, slots: 1 },
      { name: "Coal", amount: 30, slots: 2 },
    ]);
  });
});

describe("scaleFromHave", () => {
  it("scales coal from ore stock", () => {
    const result = scaleFromHave(steel, 0, 100);
    expect(result.crafts).toBe(100);
    expect(result.amounts).toEqual([
      { name: "Ore", amount: 100 },
      { name: "Coal", amount: 300 },
    ]);
  });

  it("floors when have is not divisible", () => {
    const recipe = [
      { name: "Ore", amountPerCraft: 2 },
      { name: "Coal", amountPerCraft: 3 },
    ];
    const result = scaleFromHave(recipe, 0, 5);
    expect(result.crafts).toBe(2);
    expect(result.amounts).toEqual([
      { name: "Ore", amount: 4 },
      { name: "Coal", amount: 6 },
    ]);
  });

  it("returns 0 crafts when stock is insufficient", () => {
    expect(scaleFromHave(steel, 0, 0).crafts).toBe(0);
  });
});
