import { Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import {
  computeMaxTrip,
  scaleFromHave,
  type Ingredient,
} from "./logic";

const STORAGE_KEY = "sak.craft-calculator.state";

const DEFAULT_INGREDIENTS: Ingredient[] = [
  { name: "Ore", amountPerCraft: 1 },
  { name: "Coal", amountPerCraft: 3 },
];

interface PersistedState {
  productName: string;
  ingredients: Ingredient[];
  inventorySlots: number;
  stackSize: number;
  reservedSlots: number;
  haveIndex: number;
  haveAmount: number;
}

const DEFAULTS: PersistedState = {
  productName: "Bar",
  ingredients: DEFAULT_INGREDIENTS,
  inventorySlots: 29,
  stackSize: 25,
  reservedSlots: 1,
  haveIndex: 0,
  haveAmount: 100,
};

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const ingredients = Array.isArray(parsed.ingredients)
      ? parsed.ingredients
          .filter(
            (i): i is Ingredient =>
              !!i &&
              typeof i === "object" &&
              typeof (i as Ingredient).name === "string" &&
              typeof (i as Ingredient).amountPerCraft === "number",
          )
          .map((i) => ({
            name: i.name,
            amountPerCraft: Math.max(0, i.amountPerCraft),
          }))
      : DEFAULT_INGREDIENTS;
    return {
      productName:
        typeof parsed.productName === "string" && parsed.productName.trim()
          ? parsed.productName
          : DEFAULTS.productName,
      ingredients: ingredients.length > 0 ? ingredients : DEFAULT_INGREDIENTS,
      inventorySlots:
        typeof parsed.inventorySlots === "number" && parsed.inventorySlots >= 0
          ? Math.floor(parsed.inventorySlots)
          : DEFAULTS.inventorySlots,
      stackSize:
        typeof parsed.stackSize === "number" && parsed.stackSize >= 1
          ? Math.floor(parsed.stackSize)
          : DEFAULTS.stackSize,
      reservedSlots:
        typeof parsed.reservedSlots === "number" && parsed.reservedSlots >= 0
          ? Math.floor(parsed.reservedSlots)
          : DEFAULTS.reservedSlots,
      haveIndex:
        typeof parsed.haveIndex === "number" && parsed.haveIndex >= 0
          ? Math.floor(parsed.haveIndex)
          : DEFAULTS.haveIndex,
      haveAmount:
        typeof parsed.haveAmount === "number" && parsed.haveAmount >= 0
          ? Math.floor(parsed.haveAmount)
          : DEFAULTS.haveAmount,
    };
  } catch {
    return DEFAULTS;
  }
}

function saveState(state: PersistedState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota */
  }
}

const fieldClass =
  "mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-brand/60 focus:outline-none";
const labelClass = "block text-xs font-medium uppercase tracking-wide text-zinc-500";

function parseNonNegInt(raw: string, fallback: number): number {
  if (raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function parsePositiveAmount(raw: string, fallback: number): number {
  if (raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export default function CraftCalculatorTool() {
  const baseId = useId();
  const initial = useMemo(() => loadState(), []);

  const [productName, setProductName] = useState(initial.productName);
  const [ingredients, setIngredients] = useState<Ingredient[]>(initial.ingredients);
  const [inventorySlots, setInventorySlots] = useState(initial.inventorySlots);
  const [stackSize, setStackSize] = useState(initial.stackSize);
  const [reservedSlots, setReservedSlots] = useState(initial.reservedSlots);
  const [haveIndex, setHaveIndex] = useState(
    Math.min(initial.haveIndex, Math.max(0, initial.ingredients.length - 1)),
  );
  const [haveAmount, setHaveAmount] = useState(initial.haveAmount);

  useEffect(() => {
    saveState({
      productName,
      ingredients,
      inventorySlots,
      stackSize,
      reservedSlots,
      haveIndex,
      haveAmount,
    });
  }, [
    productName,
    ingredients,
    inventorySlots,
    stackSize,
    reservedSlots,
    haveIndex,
    haveAmount,
  ]);

  useEffect(() => {
    if (haveIndex >= ingredients.length) {
      setHaveIndex(Math.max(0, ingredients.length - 1));
    }
  }, [ingredients.length, haveIndex]);

  const trip = useMemo(
    () => computeMaxTrip(ingredients, inventorySlots, stackSize, reservedSlots),
    [ingredients, inventorySlots, stackSize, reservedSlots],
  );

  const scaled = useMemo(
    () => scaleFromHave(ingredients, haveIndex, haveAmount),
    [ingredients, haveIndex, haveAmount],
  );

  const productLabel = productName.trim() || "product";

  function updateIngredient(index: number, patch: Partial<Ingredient>) {
    setIngredients((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  function addIngredient() {
    setIngredients((rows) => [...rows, { name: "", amountPerCraft: 1 }]);
  }

  function removeIngredient(index: number) {
    setIngredients((rows) => {
      if (rows.length <= 1) return rows;
      return rows.filter((_, i) => i !== index);
    });
  }

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
        <h2 className="text-sm font-medium text-zinc-200">Recipe</h2>

        <div>
          <label className={labelClass} htmlFor={`${baseId}-product`}>
            Product name
          </label>
          <input
            id={`${baseId}-product`}
            type="text"
            value={productName}
            onChange={(e) => setProductName(e.target.value)}
            placeholder="Bar"
            className={fieldClass}
          />
        </div>

        <div className="space-y-3">
          <p className={labelClass}>Ingredients (per craft)</p>
          {ingredients.map((ing, index) => (
            <div key={index} className="flex flex-wrap items-end gap-3">
              <div className="min-w-[10rem] flex-1">
                <label className={labelClass} htmlFor={`${baseId}-name-${index}`}>
                  Name
                </label>
                <input
                  id={`${baseId}-name-${index}`}
                  type="text"
                  value={ing.name}
                  onChange={(e) => updateIngredient(index, { name: e.target.value })}
                  placeholder="Ore"
                  className={fieldClass}
                />
              </div>
              <div className="w-28">
                <label className={labelClass} htmlFor={`${baseId}-amt-${index}`}>
                  Amount
                </label>
                <input
                  id={`${baseId}-amt-${index}`}
                  type="number"
                  min={0.01}
                  step="any"
                  value={ing.amountPerCraft}
                  onChange={(e) =>
                    updateIngredient(index, {
                      amountPerCraft: parsePositiveAmount(e.target.value, 1),
                    })
                  }
                  className={fieldClass}
                />
              </div>
              <button
                type="button"
                onClick={() => removeIngredient(index)}
                disabled={ingredients.length <= 1}
                className="mb-0.5 inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-700 text-zinc-400 hover:border-brand/60 hover:text-brand disabled:opacity-30 disabled:hover:border-zinc-700 disabled:hover:text-zinc-400"
                aria-label={`Remove ingredient ${index + 1}`}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addIngredient}
            className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-brand-soft transition-colors"
          >
            <Plus size={16} />
            Add ingredient
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
        <h2 className="text-sm font-medium text-zinc-200">Inventory</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className={labelClass} htmlFor={`${baseId}-slots`}>
              Inventory slots
            </label>
            <input
              id={`${baseId}-slots`}
              type="number"
              min={0}
              step={1}
              value={inventorySlots}
              onChange={(e) =>
                setInventorySlots(parseNonNegInt(e.target.value, inventorySlots))
              }
              className={fieldClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`${baseId}-stack`}>
              Items per slot
            </label>
            <input
              id={`${baseId}-stack`}
              type="number"
              min={1}
              step={1}
              value={stackSize}
              onChange={(e) => {
                const n = parseNonNegInt(e.target.value, stackSize);
                setStackSize(Math.max(1, n));
              }}
              className={fieldClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`${baseId}-reserved`}>
              Reserved slots
            </label>
            <input
              id={`${baseId}-reserved`}
              type="number"
              min={0}
              step={1}
              value={reservedSlots}
              onChange={(e) =>
                setReservedSlots(parseNonNegInt(e.target.value, reservedSlots))
              }
              className={fieldClass}
            />
            <p className="mt-1 text-xs text-zinc-500">
              Empty slots left for {productLabel} to start stacking into.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 space-y-4">
        <h2 className="text-sm font-medium text-zinc-200">Bank withdraw</h2>
        <p className="text-sm text-zinc-400">
          Material fill only — {reservedSlots} slot
          {reservedSlots === 1 ? "" : "s"} reserved for output. As you craft,
          consumed stacks free slots for more {productLabel}.
        </p>

        <div className="flex flex-wrap gap-6 text-sm">
          <div>
            <p className="text-zinc-500">Max crafts</p>
            <p className="text-2xl font-semibold text-zinc-100 tabular-nums">
              {trip.crafts}
            </p>
          </div>
          <div>
            <p className="text-zinc-500">{productLabel} produced</p>
            <p className="text-2xl font-semibold text-zinc-100 tabular-nums">
              {trip.crafts}
            </p>
          </div>
          <div>
            <p className="text-zinc-500">Material slots used</p>
            <p className="text-2xl font-semibold text-zinc-100 tabular-nums">
              {trip.materialSlotsUsed}
              <span className="text-base font-normal text-zinc-500">
                {" "}
                / {trip.usableSlots}
              </span>
            </p>
          </div>
        </div>

        {trip.withdraw.length === 0 ? (
          <p className="text-sm text-zinc-500">Add ingredients with amounts &gt; 0.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-zinc-500 border-b border-zinc-800">
                <th className="py-2 font-medium">Withdraw</th>
                <th className="py-2 font-medium tabular-nums">Amount</th>
                <th className="py-2 font-medium tabular-nums">Slots</th>
              </tr>
            </thead>
            <tbody>
              {trip.withdraw.map((row) => (
                <tr key={row.name} className="border-b border-zinc-800/60">
                  <td className="py-2 text-zinc-200">{row.name}</td>
                  <td className="py-2 tabular-nums text-zinc-100">{row.amount}</td>
                  <td className="py-2 tabular-nums text-zinc-400">{row.slots}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {trip.emptySlots > 0 && trip.crafts > 0 && (
          <p className="text-xs text-zinc-500">
            {trip.emptySlots} unused material slot
            {trip.emptySlots === 1 ? "" : "s"} (ratio does not fill them evenly).
          </p>
        )}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 space-y-4">
        <h2 className="text-sm font-medium text-zinc-200">Scale from stock</h2>
        <p className="text-sm text-zinc-400">
          Given how much of one ingredient you have, how much of the others you need.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[10rem] flex-1">
            <label className={labelClass} htmlFor={`${baseId}-have-ing`}>
              Ingredient
            </label>
            <select
              id={`${baseId}-have-ing`}
              value={haveIndex}
              onChange={(e) => setHaveIndex(Number(e.target.value))}
              className={fieldClass}
            >
              {ingredients.map((ing, index) => (
                <option key={index} value={index}>
                  {ing.name.trim() || `Ingredient ${index + 1}`}
                </option>
              ))}
            </select>
          </div>
          <div className="w-36">
            <label className={labelClass} htmlFor={`${baseId}-have-amt`}>
              I have
            </label>
            <input
              id={`${baseId}-have-amt`}
              type="number"
              min={0}
              step={1}
              value={haveAmount}
              onChange={(e) =>
                setHaveAmount(parseNonNegInt(e.target.value, haveAmount))
              }
              className={fieldClass}
            />
          </div>
        </div>

        <div className="text-sm space-y-2">
          <p className="text-zinc-400">
            Crafts possible:{" "}
            <span className="font-medium text-zinc-100 tabular-nums">
              {scaled.crafts}
            </span>
          </p>
          <ul className="space-y-1">
            {scaled.amounts.map((row) => (
              <li key={row.name} className="flex justify-between gap-4 text-zinc-300">
                <span>{row.name}</span>
                <span className="tabular-nums text-zinc-100">{row.amount}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
