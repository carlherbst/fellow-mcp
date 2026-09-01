/**
 * Fellow Espresso Series 1 ("Solo") API client.
 *
 * Same host and same Bearer JWT as the Aiden client in `fellow-api.ts`, but
 * every device-scoped route carries a `solo/` product segment under the `/v2`
 * stage:
 *
 *   Aiden             /v1/devices/{id}/profiles
 *   Espresso Series 1 /v2/solo/devices/{FS_id}/profiles
 *
 * There is no Cognito, SigV4, MQTT or IoT Core anywhere in this path — the
 * device-shadow theory that the `awsStatus`/`settingsVersion`/`version` fields
 * suggest is wrong; the app bundle contains no IoT endpoint or topic.
 *
 * Espresso profiles are pressure profiles and share no fields with Aiden brew
 * profiles, which is why this is a separate client rather than a flag on
 * FellowClient.
 *
 * Unofficial and undocumented — can break without notice.
 */

import { API_HOST, USER_AGENT, FellowApiError, FellowDevice } from "./fellow-api.js";

const SOLO_BASE = `${API_HOST}/v2/solo`;

/**
 * An espresso profile.
 *
 * Field names, types and observed ranges below were read off a live Espresso
 * Series 1 (firmware 2.3.20) via GET /v2/solo/devices/{id}/profiles.
 * Documented limits that are wider than what Fellow's own profiles use are
 * attributed to `ehthayer/curvia`'s FELLOW_API.md.
 *
 * Unknown fields are preserved on read so a round-trip never drops data we
 * did not model.
 */
export interface SoloProfile extends Record<string, unknown> {
  id?: string;
  title?: string;
  /** grams of dry coffee. Observed 18–19; documented limit 6–30. */
  dose?: number;
  /** yield ratio, i.e. 2 means 1:2. Observed 1.5–3; documented limit <= 5. */
  ratio?: number;
  /** brew temperature °C. Observed 90–94; documented limit 50–94. */
  temperature?: number;
  /** grind setting, fractional. Observed 0–2; documented limit <= 10. */
  grindSize?: number;
  adaptive?: boolean;
  /** "off" observed; curvia documents "on"/"off". NOT a boolean. */
  decliningTemp?: string;
  /** A string enum, NOT a number. Only "smooth" observed across 17 profiles. */
  transition?: string;
  preInfusionEnabled?: boolean;
  /** seconds. Observed 1–14. */
  preInfusionDuration?: number;
  /** Observed 3–6.5. */
  preInfusionFillFlowRate?: number;
  /** bar. Observed 3–9. */
  preInfusionHoldPressure?: number;
  /**
   * Ordered pressure stages. Observed 1–6 stages, pressure 3–9 bar,
   * duration 5–30 s; documented limits 10 stages / 9 bar / 120 s.
   */
  infusion?: Array<{ duration: number; pressure: number }>;
  rampDownEnabled?: boolean;
  /** seconds. Observed 1–10. */
  rampDownDuration?: number;
  /** bar. Observed 3–9. */
  rampDownEndPressure?: number;
  /** Free text shown in the app. Fellow uses it for tasting notes. */
  notes?: string;

  // ---- server-side, read-only ----
  /** "fellow" (built-in) | "drops" (Fellow Drops) | "custom" (user-created) */
  folder?: string;
  /** Drops catalog metadata — present only on folder="drops". */
  roasterName?: string;
  imageUrl?: string;
  blurHash?: string;
  status?: string;
  scheduledAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

/**
 * The fields a client may actually set. Anything outside this list is either
 * server-managed or Drops catalog metadata, and Fellow's DTO validation runs
 * `forbidNonWhitelisted` — an unexpected property is a 400 naming it.
 */
export const SOLO_EDITABLE_FIELDS = [
  "title",
  "dose",
  "ratio",
  "temperature",
  "grindSize",
  "adaptive",
  "decliningTemp",
  "transition",
  "preInfusionEnabled",
  "preInfusionDuration",
  "preInfusionFillFlowRate",
  "preInfusionHoldPressure",
  "infusion",
  "rampDownEnabled",
  "rampDownDuration",
  "rampDownEndPressure",
  "notes",
] as const;

export type SoloProfileCategory = "custom" | "fellow" | "drops" | "unknown";

export function categorizeSolo(p: SoloProfile): SoloProfileCategory {
  const f = (p.folder ?? "").toLowerCase();
  if (f === "custom" || f === "fellow" || f === "drops") return f as SoloProfileCategory;
  return "unknown";
}

/**
 * Every write carries a client-generated `settingsVersion` in whole seconds.
 * The server resolves conflicts last-write-wins on this value, so a client
 * with a slow clock silently loses to one with a fast clock.
 *
 * Caveat: profile objects come back from GET *without* a settingsVersion —
 * only the device object carries one. That it belongs on a profile write is
 * curvia's claim, not something we have observed. `call()` recovers if it is
 * wrong (see the forbidden-property retry).
 */
function stamp(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Build a write body by allowlist. A denylist would be wrong here: Fellow
 * validates with `forbidNonWhitelisted`, so any field we failed to anticipate
 * — including the Drops catalog metadata that rides along on read — becomes a
 * 400 rather than being ignored.
 */
function writeBody(profile: SoloProfile): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of SOLO_EDITABLE_FIELDS) {
    if (profile[f] !== undefined) body[f] = profile[f];
  }
  // `folder` is read-only in practice — a client has no business moving a
  // profile into Fellow's built-in or Drops namespace — but the write DTO
  // requires it present and a string ("folder must be a string" on a create
  // that omits it, observed live). So it is set here rather than exposed as a
  // tool parameter. Anything a user creates is "custom"; an update preserves
  // whatever the profile already had.
  body.folder = typeof profile.folder === "string" ? profile.folder : "custom";
  body.settingsVersion = stamp();
  return body;
}

/**
 * Pull property names out of a class-validator rejection.
 * Fellow returns e.g. { message: ["property foo should not exist"] }.
 */
function forbiddenProperties(body: unknown): string[] {
  const raw = (body as { message?: unknown })?.message;
  const msgs = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  const names: string[] = [];
  for (const m of msgs) {
    const hit = /property (\w+) should not exist/i.exec(String(m));
    if (hit) names.push(hit[1]);
  }
  return names;
}

/**
 * Compare what we sent against what Fellow echoed back.
 *
 * The API is undocumented, so a renamed or silently-ignored field would still
 * return 200 with an id and look like success — while the machine brews
 * something other than what was asked for. Surface any mismatch loudly rather
 * than reporting a clean write.
 */
export function diffSoloEcho(
  sent: Record<string, unknown>,
  received: Record<string, unknown>,
): string[] {
  // When a stage is disabled the server nulls its dependent fields, so sending
  // them and getting null back is correct behaviour, not drift. Reporting it
  // would fire a warning on most writes.
  const piOff = sent.preInfusionEnabled === false;
  const rdOff = sent.rampDownEnabled === false;
  const keys = SOLO_EDITABLE_FIELDS.filter((k) => {
    if (sent[k] === undefined) return false;
    if (piOff && k.startsWith("preInfusion") && k !== "preInfusionEnabled") return false;
    if (rdOff && k.startsWith("rampDown") && k !== "rampDownEnabled") return false;
    return true;
  });

  const echoed = keys.filter((k) => received[k] !== undefined).length;
  if (keys.length && echoed < Math.min(3, keys.length)) {
    return [
      "Fellow's response no longer echoes the saved profile fields (possible API change) — can't verify the write landed with the right values. Check the profile in the Fellow app before brewing.",
    ];
  }

  const issues: string[] = [];
  for (const key of keys) {
    const a = sent[key];
    const b = received[key];
    if (key === "infusion") {
      // Compare stage by stage, not with JSON.stringify — Fellow echoes the
      // same stages with `pressure` before `duration`, so a stringify compare
      // reports drift on every single write. A warning that always fires is
      // one the user learns to ignore.
      const as = Array.isArray(a) ? (a as Array<Record<string, unknown>>) : [];
      const bs = Array.isArray(b) ? (b as Array<Record<string, unknown>>) : [];
      if (as.length !== bs.length) {
        issues.push(`infusion: sent ${as.length} stages, Fellow saved ${bs.length}`);
      } else {
        for (let i = 0; i < as.length; i++) {
          if (as[i]?.duration !== bs[i]?.duration || as[i]?.pressure !== bs[i]?.pressure) {
            issues.push(
              `infusion stage ${i + 1}: sent ${as[i]?.pressure}bar×${as[i]?.duration}s, ` +
                `Fellow saved ${bs[i]?.pressure}bar×${bs[i]?.duration}s`,
            );
          }
        }
      }
      continue;
    }
    if (typeof a === "number") {
      // Fellow rounds some fields server-side; tolerate float noise only.
      if (typeof b !== "number" || Math.abs(a - b) > 1e-6) {
        issues.push(`${key}: sent ${a}, Fellow saved ${JSON.stringify(b)}`);
      }
    } else if (a !== b) {
      issues.push(`${key}: sent ${JSON.stringify(a)}, Fellow saved ${JSON.stringify(b)}`);
    }
  }
  return issues;
}

export class SoloClient {
  private device: FellowDevice | null = null;

  /**
   * @param jwt   a Fellow access JWT (same one the Aiden client uses)
   * @param resolveDevice  supplies the Series 1 device; injected so this
   *                       client does not duplicate device discovery.
   */
  constructor(
    private jwt: string,
    private resolveDevice: () => Promise<FellowDevice>,
  ) {}

  private headers(): HeadersInit {
    return {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Authorization: `Bearer ${this.jwt}`,
    };
  }

  async getDevice(): Promise<FellowDevice> {
    if (!this.device) this.device = await this.resolveDevice();
    return this.device;
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    /** internal: guards the forbidden-property retry against looping */
    retriesLeft = 3,
  ): Promise<unknown> {
    const { id } = await this.getDevice();
    const r = await fetch(`${SOLO_BASE}/devices/${id}${path}`, {
      method,
      headers: this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body — keep the raw text for the error message
    }

    if (!r.ok) {
      // Fellow's schema is undocumented and we have not observed a write.
      // When it rejects a property by name, drop that property and retry
      // rather than failing the user's request on our own bad guess.
      const forbidden = forbiddenProperties(parsed);
      if (
        r.status === 400 &&
        forbidden.length &&
        retriesLeft > 0 &&
        body &&
        typeof body === "object"
      ) {
        const trimmed = { ...(body as Record<string, unknown>) };
        let dropped = false;
        for (const f of forbidden) {
          if (f in trimmed) {
            delete trimmed[f];
            dropped = true;
          }
        }
        if (dropped) return this.call(method, path, trimmed, retriesLeft - 1);
      }

      const msg =
        (parsed as { message?: string | string[] })?.message ??
        `${method} ${path} failed`;
      throw new FellowApiError(
        Array.isArray(msg) ? msg.join("; ") : String(msg),
        r.status,
        parsed,
      );
    }
    return parsed;
  }

  async listProfiles(): Promise<SoloProfile[]> {
    const body = (await this.call("GET", "/profiles")) as SoloProfile[];
    return Array.isArray(body) ? body : [];
  }

  async createProfile(profile: SoloProfile): Promise<SoloProfile> {
    return (await this.call("POST", "/profiles", writeBody(profile))) as SoloProfile;
  }

  /**
   * PATCH validates the whole DTO, so callers must merge changes onto the
   * existing profile and send it complete — a sparse patch is rejected.
   */
  async updateProfile(profileId: string, profile: SoloProfile): Promise<SoloProfile> {
    return (await this.call(
      "PATCH",
      `/profiles/${profileId}`,
      writeBody(profile),
    )) as SoloProfile;
  }

  /** Unusually for a DELETE, this one requires a body. */
  async deleteProfile(profileId: string): Promise<void> {
    await this.call("DELETE", `/profiles/${profileId}`, { settingsVersion: stamp() });
  }

  /** Sets the profile shown on the machine's front panel. */
  async setActiveProfile(profileId: string): Promise<void> {
    await this.call("PATCH", "/active-profile", {
      profileId,
      settingsVersion: stamp(),
    });
  }

  /**
   * Mint a brew.link. The link is a permanent, immutable, non-revocable
   * snapshot carrying a pseudonymous `sharedFrom` id — there is no unshare.
   */
  async shareProfile(profileId: string): Promise<string> {
    const body = (await this.call("POST", `/profiles/${profileId}/share`)) as {
      link?: string;
    };
    if (!body?.link) {
      throw new FellowApiError("Failed to generate brew.link", undefined, body);
    }
    return body.link;
  }

  /** Find by id or exact case-sensitive title. */
  async findProfile(idOrTitle: string): Promise<SoloProfile | null> {
    const profiles = await this.listProfiles();
    return profiles.find((p) => p.id === idOrTitle || p.title === idOrTitle) ?? null;
  }
}
