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
 * Field names and ranges below come from `ehthayer/curvia`'s FELLOW_API.md,
 * derived from the Fellow Android app's Hermes bundle and verified end-to-end
 * against a real machine by its author — but not yet against ours. Unknown
 * fields are preserved on read so a round-trip never drops data we didn't
 * model.
 */
export interface SoloProfile extends Record<string, unknown> {
  id?: string;
  title?: string;
  /** grams of dry coffee, 6–30 */
  dose?: number;
  /** yield ratio, <= 5 */
  ratio?: number;
  /** brew temperature °C, 50–94 */
  temperature?: number;
  /** grind setting, <= 10 */
  grindSize?: number;
  adaptive?: boolean;
  /** "on" | "off" — declining temperature across the shot */
  decliningTemp?: string;
  transition?: number;
  preInfusionEnabled?: boolean;
  preInfusionDuration?: number;
  preInfusionFillFlowRate?: number;
  preInfusionHoldPressure?: number;
  /** ordered pressure stages, up to 10; pressure <= 9 bar, duration <= 120 s */
  infusion?: Array<{ duration: number; pressure: number }>;
  rampDownEnabled?: boolean;
  rampDownDuration?: number;
  rampDownEndPressure?: number;
  /** "fellow" (built-in) | "drops" (Fellow Drops) | "custom" (user-created) */
  folder?: string;
}

export type SoloProfileCategory = "custom" | "fellow" | "drops" | "unknown";

export function categorizeSolo(p: SoloProfile): SoloProfileCategory {
  const f = (p.folder ?? "").toLowerCase();
  if (f === "custom" || f === "fellow" || f === "drops") return f as SoloProfileCategory;
  return "unknown";
}

/**
 * Server-managed fields that come back on reads and must not be echoed into
 * writes. Fellow's DTO validation runs `forbidNonWhitelisted`, so an
 * unexpected property is a 400 naming the property.
 *
 * `settingsVersion` is deliberately NOT in this list — writes must carry a
 * fresh one (see `stamp()`).
 */
export const SOLO_SERVER_SIDE_FIELDS = [
  "id",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "deviceId",
  "sharedFrom",
  "synced",
  "lastUsedTime",
  "isDefaultProfile",
  "folder",
];

/**
 * Every write carries a client-generated `settingsVersion` in whole seconds.
 * The server resolves conflicts last-write-wins on this value, so a client
 * with a slow clock silently loses to one with a fast clock.
 */
function stamp(): number {
  return Math.floor(Date.now() / 1000);
}

function writeBody(profile: SoloProfile): Record<string, unknown> {
  const body: Record<string, unknown> = { ...profile };
  for (const f of SOLO_SERVER_SIDE_FIELDS) delete body[f];
  body.settingsVersion = stamp();
  return body;
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
