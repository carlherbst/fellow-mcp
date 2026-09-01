/**
 * Client-side validation for Espresso Series 1 profiles.
 *
 * Catching a bad value here produces a sentence the model can act on; letting
 * it reach Fellow produces a class-validator 400 array.
 *
 * Bounds are the documented server-enforced limits (curvia's FELLOW_API.md).
 * Where Fellow's own 17 shipped profiles use a narrower band, the observed
 * band is noted in the field description — a value outside it is legal but
 * unusual, and the model should have a reason.
 */

import { z } from "zod";

export const infusionStageSchema = z.object({
  duration: z.coerce
    .number()
    .min(1)
    .max(120)
    .describe("Stage length in seconds. Fellow's own profiles use 5–30."),
  pressure: z.coerce
    .number()
    .min(0)
    .max(9)
    .describe("Stage pressure in bar, max 9. Fellow's own profiles use 3–9."),
});

/** Fields shared by create and update. Optionality differs, so this is the base. */
export const soloProfileFields = {
  title: z.string().min(1).max(50).describe("Profile name as it appears on the machine"),
  dose: z.coerce
    .number()
    .min(6)
    .max(30)
    .describe("Dry coffee in grams, 6–30. Fellow's own profiles use 18–19."),
  ratio: z.coerce
    .number()
    .min(1)
    .max(5)
    .describe(
      "Yield ratio — 2 means 1:2, i.e. 18g in for 36g out. Max 5. Fellow's own profiles use 1.5–3.",
    ),
  temperature: z.coerce
    .number()
    .min(50)
    .max(94)
    .describe("Brew temperature in °C, 50–94. Fellow's own profiles use 90–94."),
  grindSize: z.coerce
    .number()
    .min(0)
    .max(10)
    .describe(
      "Grind setting on the machine's own scale, 0–10, fractional allowed. Fellow's own profiles use 0–2. This is NOT a Varia VS6 or Ode setting.",
    ),
  adaptive: z.coerce
    .boolean()
    .describe("Let the machine adapt the shot in real time to hit the target ratio"),
  decliningTemp: z
    .enum(["on", "off"])
    .describe("Declining temperature across the shot. A string, not a boolean."),
  transition: z
    .string()
    .describe(
      'How pressure moves between infusion stages. Only "smooth" has been observed across all 17 of Fellow\'s profiles — other values may exist but are unverified.',
    ),
  preInfusionEnabled: z.coerce.boolean(),
  preInfusionDuration: z.coerce
    .number()
    .min(0)
    .max(120)
    .describe("Pre-infusion length in seconds. Fellow's own profiles use 1–14."),
  preInfusionFillFlowRate: z.coerce
    .number()
    .min(0)
    .max(10)
    .describe("Fill flow rate during pre-infusion. Fellow's own profiles use 3–6.5."),
  preInfusionHoldPressure: z.coerce
    .number()
    .min(0)
    .max(9)
    .describe("Pressure held during pre-infusion, in bar. Fellow's own profiles use 3–9."),
  infusion: z
    .array(infusionStageSchema)
    .min(1)
    .max(10)
    .describe(
      "Ordered pressure stages, 1–10. This is the shape of the shot: e.g. [{duration:15,pressure:9},{duration:10,pressure:7},{duration:5,pressure:5}] is a declining-pressure extraction.",
    ),
  rampDownEnabled: z.coerce.boolean(),
  rampDownDuration: z.coerce
    .number()
    .min(0)
    .max(120)
    .describe("Ramp-down length in seconds. Fellow's own profiles use 1–10."),
  rampDownEndPressure: z.coerce
    .number()
    .min(0)
    .max(9)
    .describe("Pressure at the end of ramp-down, in bar. Fellow's own profiles use 3–9."),
  notes: z
    .string()
    .max(2000)
    .optional()
    .describe("Free text shown in the Fellow app — tasting notes, dial-in history, bean details"),
};

/**
 * Create: everything required except notes, with defaults matching Fellow's
 * "Classic 9 bar" built-in so a caller can specify only what it cares about.
 */
export const soloCreateSchema = z.object({
  ...soloProfileFields,
  adaptive: soloProfileFields.adaptive.default(false),
  decliningTemp: soloProfileFields.decliningTemp.default("off"),
  transition: soloProfileFields.transition.default("smooth"),
  preInfusionEnabled: soloProfileFields.preInfusionEnabled.default(false),
  preInfusionDuration: soloProfileFields.preInfusionDuration.default(1),
  preInfusionFillFlowRate: soloProfileFields.preInfusionFillFlowRate.default(6.5),
  preInfusionHoldPressure: soloProfileFields.preInfusionHoldPressure.default(9),
  rampDownEnabled: soloProfileFields.rampDownEnabled.default(false),
  rampDownDuration: soloProfileFields.rampDownDuration.default(1),
  rampDownEndPressure: soloProfileFields.rampDownEndPressure.default(9),
  grindSize: soloProfileFields.grindSize.default(0),
});

/**
 * Update: every field optional, merged onto the existing profile.
 *
 * Every field is wrapped unconditionally. An earlier version wrapped only when
 * `!v.isOptional()`, which is wrong for `z.coerce.boolean()`: coercion means
 * `Boolean(undefined) === false`, so the schema never rejects, `isOptional()`
 * reports true, and the field is left unwrapped. An omitted boolean then parses
 * to `false` instead of `undefined` — so updating one field silently set
 * `adaptive`, `preInfusionEnabled` and `rampDownEnabled` to false and the server
 * nulled every dependent pre-infusion and ramp-down value. Observed live.
 */
export const soloUpdateFields = Object.fromEntries(
  Object.entries(soloProfileFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]),
) as { [K in keyof typeof soloProfileFields]: z.ZodOptional<z.ZodTypeAny> };

/**
 * Sanity checks that a per-field schema cannot express.
 * Returns human-readable problems; empty means fine.
 */
export function checkSoloConsistency(p: {
  infusion?: Array<{ duration: number; pressure: number }>;
  preInfusionEnabled?: boolean;
  preInfusionDuration?: number;
  rampDownEnabled?: boolean;
  rampDownDuration?: number;
  dose?: number;
  ratio?: number;
}): string[] {
  const errors: string[] = [];

  if (p.infusion && !p.infusion.length) {
    errors.push("infusion must have at least one stage — a shot with no pressure stages cannot brew.");
  }
  if (p.preInfusionEnabled && (p.preInfusionDuration ?? 0) <= 0) {
    errors.push(
      "preInfusionEnabled is true but preInfusionDuration is 0 — either set a duration or disable pre-infusion.",
    );
  }
  if (p.rampDownEnabled && (p.rampDownDuration ?? 0) <= 0) {
    errors.push(
      "rampDownEnabled is true but rampDownDuration is 0 — either set a duration or disable ramp-down.",
    );
  }

  const total =
    (p.infusion?.reduce((s, st) => s + (st.duration ?? 0), 0) ?? 0) +
    (p.preInfusionEnabled ? (p.preInfusionDuration ?? 0) : 0) +
    (p.rampDownEnabled ? (p.rampDownDuration ?? 0) : 0);
  if (total > 120) {
    errors.push(`Total shot time is ${total}s. That is far beyond any normal espresso shot (20–40s).`);
  }

  if (p.dose != null && p.ratio != null) {
    const yieldG = p.dose * p.ratio;
    if (yieldG > 100) {
      errors.push(
        `dose ${p.dose}g at ratio 1:${p.ratio} yields ${yieldG.toFixed(0)}g — larger than the cup most people expect. Confirm this is intended.`,
      );
    }
  }

  return errors;
}
