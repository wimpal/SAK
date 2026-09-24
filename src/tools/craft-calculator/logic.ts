export interface Ingredient {
  name: string;
  amountPerCraft: number;
}

export interface WithdrawRow {
  name: string;
  amount: number;
  slots: number;
}

export interface MaxCraftResult {
  crafts: number;
  withdraw: WithdrawRow[];
  materialSlotsUsed: number;
  usableSlots: number;
  emptySlots: number;
}

export interface ScaleResult {
  crafts: number;
  amounts: { name: string; amount: number }[];
}

/** Slots needed to hold `amount` items at `stackSize` per slot. */
export function slotsForAmount(amount: number, stackSize: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const stack = Math.max(1, Math.floor(stackSize));
  return Math.ceil(amount / stack);
}

/** Merge ingredients with the same name (case-insensitive trim) by summing amounts. */
export function aggregateIngredients(ingredients: Ingredient[]): Ingredient[] {
  const map = new Map<string, Ingredient>();
  for (const ing of ingredients) {
    const name = ing.name.trim() || "Item";
    const key = name.toLowerCase();
    const amount = Number.isFinite(ing.amountPerCraft)
      ? Math.max(0, ing.amountPerCraft)
      : 0;
    const prev = map.get(key);
    if (prev) {
      prev.amountPerCraft += amount;
    } else {
      map.set(key, { name, amountPerCraft: amount });
    }
  }
  return [...map.values()].filter((i) => i.amountPerCraft > 0);
}

export function materialSlotsUsed(
  ingredients: Ingredient[],
  crafts: number,
  stackSize: number,
): number {
  if (crafts <= 0) return 0;
  const aggregated = aggregateIngredients(ingredients);
  let total = 0;
  for (const ing of aggregated) {
    total += slotsForAmount(ing.amountPerCraft * crafts, stackSize);
  }
  return total;
}

export function withdrawAmounts(
  ingredients: Ingredient[],
  crafts: number,
  stackSize: number,
): WithdrawRow[] {
  const aggregated = aggregateIngredients(ingredients);
  const n = Math.max(0, Math.floor(crafts));
  return aggregated.map((ing) => {
    const amount = ing.amountPerCraft * n;
    return {
      name: ing.name,
      amount,
      slots: slotsForAmount(amount, stackSize),
    };
  });
}

/**
 * Max crafts that fit in `usableSlots` as ingredients only.
 * Binary-search over n ≥ 0.
 */
export function maxCrafts(
  ingredients: Ingredient[],
  usableSlots: number,
  stackSize: number,
): number {
  const aggregated = aggregateIngredients(ingredients);
  if (aggregated.length === 0) return 0;

  const slots = Math.max(0, Math.floor(usableSlots));
  const stack = Math.max(1, Math.floor(stackSize));
  if (slots <= 0) return 0;

  // Upper bound: even the cheapest ingredient needs at least 1 slot per stack of crafts
  const minPerCraft = Math.min(...aggregated.map((i) => i.amountPerCraft));
  if (!(minPerCraft > 0)) return 0;
  let hi = slots * stack + 1;
  // Also bound by densest packing: if every slot filled with the rarest ingredient alone
  for (const ing of aggregated) {
    hi = Math.max(hi, Math.floor((slots * stack) / ing.amountPerCraft) + 1);
  }

  let lo = 0;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (materialSlotsUsed(aggregated, mid, stack) <= slots) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

export function computeMaxTrip(
  ingredients: Ingredient[],
  inventorySlots: number,
  stackSize: number,
  reservedSlots: number,
): MaxCraftResult {
  const inv = Math.max(0, Math.floor(inventorySlots));
  const reserved = Math.min(
    Math.max(0, Math.floor(reservedSlots)),
    inv,
  );
  const usable = inv - reserved;
  const crafts = maxCrafts(ingredients, usable, stackSize);
  const withdraw = withdrawAmounts(ingredients, crafts, stackSize);
  const used = withdraw.reduce((s, w) => s + w.slots, 0);
  return {
    crafts,
    withdraw,
    materialSlotsUsed: used,
    usableSlots: usable,
    emptySlots: usable - used,
  };
}

/**
 * Scale recipe from owning `have` of ingredients[index].
 * crafts = floor(have / amountPerCraft); amounts = crafts * each amount.
 */
export function scaleFromHave(
  ingredients: Ingredient[],
  index: number,
  have: number,
): ScaleResult {
  const aggregated = aggregateIngredients(ingredients);
  if (aggregated.length === 0) {
    return { crafts: 0, amounts: [] };
  }

  // Resolve index against original list name, then find in aggregated
  const source = ingredients[index];
  if (!source) {
    return { crafts: 0, amounts: aggregated.map((i) => ({ name: i.name, amount: 0 })) };
  }
  const key = source.name.trim().toLowerCase() || "item";
  const target =
    aggregated.find((i) => i.name.toLowerCase() === key) ?? aggregated[0];
  const per = target.amountPerCraft;
  const stock = Number.isFinite(have) ? Math.max(0, Math.floor(have)) : 0;
  const crafts = per > 0 ? Math.floor(stock / per) : 0;

  return {
    crafts,
    amounts: aggregated.map((ing) => ({
      name: ing.name,
      amount: ing.amountPerCraft * crafts,
    })),
  };
}

export function isValidPositiveInt(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

export function isValidPositiveAmount(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
