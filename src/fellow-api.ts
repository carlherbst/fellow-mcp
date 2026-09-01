/**
 * Fellow Aiden API client.
 *
 * Talks to the same private API the official Fellow iOS app uses.
 * No public docs — endpoints discovered from the iOS app traffic.
 * Could change without notice.
 *
 * Auth model: each MCP request brings its own Fellow email/password
 * via headers, we exchange them for a JWT, use it for one batch of
 * calls, discard. Nothing is stored server-side.
 */

export const API_HOST = "https://l8qtmnc692.execute-api.us-west-2.amazonaws.com";
const BASE_URL = `${API_HOST}/v1`;
export const USER_AGENT = "Fellow/5 CFNetwork/1568.300.101 Darwin/24.2.0";

export interface FellowProfile {
  id?: string;
  profileType: number;
  title: string;
  ratio: number;
  bloomEnabled: boolean;
  bloomRatio: number;
  bloomDuration: number;
  bloomTemperature: number;
  ssPulsesEnabled: boolean;
  ssPulsesNumber: number;
  ssPulsesInterval: number;
  ssPulseTemperatures: number[];
  batchPulsesEnabled: boolean;
  batchPulsesNumber: number;
  batchPulsesInterval: number;
  batchPulseTemperatures: number[];
}

export interface FellowDevice {
  id: string;
  displayName?: string;
  /**
   * Product family. "Solo" is the Espresso Series 1; the Aiden reports
   * something else. Fellow partitions its API by this value — see
   * `apiPrefix()`.
   */
  deviceType?: string;
  firmwareVersion?: string;
  isConnected?: boolean;
  activeProfileId?: string;
  settingsVersion?: number;
  enabledFlags?: string[];
}

/**
 * Fellow's app builds every device URL as
 *   getApiPrefix(deviceType) + "devices/" + id + path
 * which yields a product path segment for the espresso machine and nothing
 * for the Aiden:
 *   Aiden             -> /v1/devices/{id}/profiles
 *   Series 1 ("Solo") -> /v2/solo/devices/{id}/profiles
 *
 * A `FS_`-prefixed Series 1 id sent to the un-prefixed Aiden route 404s with
 * "Device could not be found" — the handler resolves ids against an
 * Aiden-only store. That 404 means wrong route, not absent capability.
 */
export function apiPrefix(deviceType?: string): string {
  const t = (deviceType ?? "").toLowerCase();
  return t ? `${t}/` : "";
}

export function isSolo(d: FellowDevice): boolean {
  return (d.deviceType ?? "").toLowerCase() === "solo";
}

/**
 * Profile categories (Fellow doesn't expose this; inferred from id prefix):
 *   - "custom":    p0…p13 — user-created profiles, capped at 14
 *   - "stock":     plocal* — built-in (Light/Medium/Dark/Cold Brew), can't delete
 *   - "shared":    d* — community/Brew Studio profiles others have shared
 */
export type ProfileCategory = "custom" | "stock" | "shared" | "unknown";

export function categorize(profile: FellowProfile): ProfileCategory {
  const id = profile.id ?? "";
  if (/^p\d+$/.test(id)) return "custom";
  if (id.startsWith("plocal")) return "stock";
  if (/^d\d+$/.test(id)) return "shared";
  return "unknown";
}

export const CUSTOM_PROFILE_CAP = 14;

/**
 * Fields Fellow manages server-side; they come back in profile reads and
 * must not be sent in writes. List mirrors 9b/fellow-aiden.
 */
export const SERVER_SIDE_PROFILE_FIELDS = [
  "id",
  "createdAt",
  "deletedAt",
  "lastUsedTime",
  "sharedFrom",
  "isDefaultProfile",
  "instantBrew",
  "folder",
  "duration",
  "lastGBQuantity",
  // Not in 9b/fellow-aiden's list; Fellow's PATCH validation rejects these
  // by name ("property deviceId should not exist", observed live 2026-06)
  "deviceId",
  "synced",
  "updatedAt",
];

export class FellowApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "FellowApiError";
  }
}

export class FellowClient {
  private token: string | null = null;
  private deviceId: string | null = null;
  private deviceName: string | null = null;

  constructor(
    private email: string,
    private password: string,
  ) {}

  /**
   * Construct a client from an existing Fellow JWT (no email/password).
   * Used by the OAuth flow: we already authenticated during /oauth/authorize,
   * the JWT is in KV, we hand it back to a fresh client for resource requests.
   */
  static fromJwt(jwt: string): FellowClient {
    const c = new FellowClient("", "");
    c.token = jwt;
    return c;
  }

  getToken(): string | null {
    return this.token;
  }

  private headers(): HeadersInit {
    const h: HeadersInit = {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  refreshToken: string | null = null;

  async authenticate(): Promise<void> {
    if (this.token) return; // already authenticated (e.g. via fromJwt)
    const r = await fetch(`${BASE_URL}/auth/login`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    const body = (await r.json()) as {
      accessToken?: string;
      refreshToken?: string;
      message?: string;
      [key: string]: unknown;
    };
    if (!body.accessToken) {
      throw new FellowApiError(
        body.message || "Login failed (check Fellow email/password)",
        r.status,
        body,
      );
    }
    this.token = body.accessToken;
    if (typeof body.refreshToken === "string") this.refreshToken = body.refreshToken;
  }

  /**
   * Exchange a Fellow refresh token for a fresh access token via
   * POST /auth/refresh-token.
   *
   * Contract (discovered empirically): the (possibly expired) access JWT goes
   * in the Authorization header — Fellow validates its signature, not its
   * expiry — and the refresh token goes in the body. Returns the new access
   * JWT. Fellow does not rotate the refresh token, so we carry it forward.
   */
  static async refresh(
    accessJwt: string,
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const r = await fetch(`${BASE_URL}/auth/refresh-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${accessJwt}`,
      },
      body: JSON.stringify({ refreshToken }),
    });
    const body = (await r.json()) as {
      accessToken?: string;
      refreshToken?: string;
      message?: string;
    };
    if (!r.ok || !body.accessToken) {
      throw new FellowApiError(body.message || "Fellow refresh failed", r.status, body);
    }
    return {
      accessToken: body.accessToken,
      refreshToken: typeof body.refreshToken === "string" ? body.refreshToken : refreshToken,
    };
  }

  /**
   * Decode the JWT exp claim (seconds since epoch). Returns null if unparseable.
   */
  static jwtExpiry(jwt: string): number | null {
    try {
      const parts = jwt.split(".");
      if (parts.length < 2) return null;
      // base64url → base64
      const payload = parts[1].replaceAll("-", "+").replaceAll("_", "/");
      const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
      const decoded = JSON.parse(atob(padded)) as { exp?: number };
      return typeof decoded.exp === "number" ? decoded.exp : null;
    } catch {
      return null;
    }
  }

  /**
   * Every device on the account, across product families. The list route is
   * the one place Fellow does not partition by product — an Aiden and an
   * Espresso Series 1 come back together.
   */
  async listDevices(): Promise<FellowDevice[]> {
    const r = await fetch(`${BASE_URL}/devices?dataType=real`, {
      headers: this.headers(),
    });
    if (!r.ok) {
      throw new FellowApiError("Failed to list devices", r.status, await r.text());
    }
    const devices = (await r.json()) as FellowDevice[];
    return Array.isArray(devices) ? devices : [];
  }

  /**
   * The Aiden brewer on this account.
   *
   * Selects by *excluding* known non-Aiden product families rather than
   * matching an Aiden `deviceType` string, because we have not observed what
   * the Aiden reports — only that the Series 1 reports "Solo". Exclusion
   * keeps a single-Aiden account working regardless.
   *
   * Previously this took `devices[0]` unconditionally, so an account with
   * only an Espresso Series 1 paired would hand a `FS_` id to the Aiden
   * routes and fail every tool with an opaque "Failed to list profiles".
   */
  async getDevice(): Promise<FellowDevice> {
    if (this.deviceId) return { id: this.deviceId, displayName: this.deviceName ?? undefined };
    const devices = await this.listDevices();
    if (!devices.length) {
      throw new FellowApiError("No devices found on this Fellow account");
    }
    const aiden = devices.find((d) => !isSolo(d));
    if (!aiden) {
      const others = devices
        .map((d) => `${d.displayName ?? d.id} (${d.deviceType ?? "unknown type"})`)
        .join(", ");
      throw new FellowApiError(
        `No Aiden brewer on this Fellow account. Found: ${others}. ` +
          `Espresso Series 1 profiles are handled by the espresso_* tools instead.`,
      );
    }
    this.deviceId = aiden.id;
    this.deviceName = aiden.displayName ?? null;
    return aiden;
  }

  /**
   * The Espresso Series 1 on this account, if paired.
   */
  async getSoloDevice(): Promise<FellowDevice> {
    const devices = await this.listDevices();
    const solo = devices.find(isSolo);
    if (!solo) {
      const others = devices.length
        ? devices.map((d) => `${d.displayName ?? d.id} (${d.deviceType ?? "unknown type"})`).join(", ")
        : "none";
      throw new FellowApiError(
        `No Espresso Series 1 on this Fellow account. Found: ${others}.`,
      );
    }
    return solo;
  }

  async listProfiles(): Promise<FellowProfile[]> {
    const { id } = await this.getDevice();
    const r = await fetch(`${BASE_URL}/devices/${id}/profiles`, {
      headers: this.headers(),
    });
    if (!r.ok) {
      throw new FellowApiError(`Failed to list profiles`, r.status, await r.text());
    }
    return (await r.json()) as FellowProfile[];
  }

  async createProfile(profile: Omit<FellowProfile, "id">): Promise<FellowProfile> {
    const { id } = await this.getDevice();
    const r = await fetch(`${BASE_URL}/devices/${id}/profiles`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(profile),
    });
    const body = (await r.json()) as FellowProfile & { message?: string; error?: string };
    if (!body.id) {
      // Common case: 14-profile cap
      if (typeof body.message === "string" && body.message.includes("maximum number of profiles")) {
        throw new FellowApiError(
          "Aiden has reached its 14-profile cap. Delete an old profile first using delete_profile.",
          r.status,
          body,
        );
      }
      throw new FellowApiError(body.message || "Failed to create profile", r.status, body);
    }
    return body;
  }

  async updateProfile(
    profileId: string,
    profile: Omit<FellowProfile, "id">,
  ): Promise<FellowProfile> {
    const { id } = await this.getDevice();
    // Fellow's gateway only routes PATCH here — PUT falls through to AWS
    // SigV4 parsing and dies on the Bearer token ("Invalid key=value pair").
    // Server-managed fields picked up from the list response must be
    // stripped or the PATCH is rejected (field list from 9b/fellow-aiden).
    const payload: Record<string, unknown> = { ...profile };
    for (const f of SERVER_SIDE_PROFILE_FIELDS) delete payload[f];
    const r = await fetch(`${BASE_URL}/devices/${id}/profiles/${profileId}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    const body = (await r.json()) as FellowProfile & { message?: string };
    if (!r.ok || (!body.id && body.id !== "")) {
      throw new FellowApiError(
        body.message || `Failed to update profile ${profileId}`,
        r.status,
        body,
      );
    }
    return body;
  }

  async deleteProfile(profileId: string): Promise<void> {
    const { id } = await this.getDevice();
    const r = await fetch(`${BASE_URL}/devices/${id}/profiles/${profileId}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!r.ok) {
      throw new FellowApiError(
        `Failed to delete profile ${profileId}`,
        r.status,
        await r.text(),
      );
    }
  }

  async shareProfile(profileId: string): Promise<string> {
    const { id } = await this.getDevice();
    const r = await fetch(`${BASE_URL}/devices/${id}/profiles/${profileId}/share`, {
      method: "POST",
      headers: this.headers(),
    });
    const body = (await r.json()) as { link?: string; message?: string };
    if (!body.link) {
      throw new FellowApiError(body.message || "Failed to generate brew.link", r.status, body);
    }
    return body.link;
  }

  /**
   * Find a profile by id OR title (case-sensitive). Returns null if not found.
   */
  async findProfile(idOrTitle: string): Promise<FellowProfile | null> {
    const profiles = await this.listProfiles();
    return profiles.find((p) => p.id === idOrTitle || p.title === idOrTitle) ?? null;
  }

  // ============================================================
  // Schedules — recurring brews triggered by the device
  // ============================================================

  async listSchedules(): Promise<FellowSchedule[]> {
    const { id } = await this.getDevice();
    const r = await fetch(`${BASE_URL}/devices/${id}/schedules`, { headers: this.headers() });
    if (!r.ok) {
      throw new FellowApiError("Failed to list schedules", r.status, await r.text());
    }
    return (await r.json()) as FellowSchedule[];
  }

  async createSchedule(schedule: Omit<FellowSchedule, "id">): Promise<FellowSchedule> {
    const { id } = await this.getDevice();
    const r = await fetch(`${BASE_URL}/devices/${id}/schedules`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(schedule),
    });
    const body = (await r.json()) as FellowSchedule & { message?: string };
    if (!r.ok || !body.id) {
      throw new FellowApiError(body.message || "Failed to create schedule", r.status, body);
    }
    return body;
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    const { id } = await this.getDevice();
    const r = await fetch(`${BASE_URL}/devices/${id}/schedules/${scheduleId}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!r.ok) {
      throw new FellowApiError(
        `Failed to delete schedule ${scheduleId}`,
        r.status,
        await r.text(),
      );
    }
  }

  async toggleSchedule(scheduleId: string, enabled: boolean): Promise<void> {
    const { id } = await this.getDevice();
    const r = await fetch(`${BASE_URL}/devices/${id}/schedules/${scheduleId}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ enabled }),
    });
    if (!r.ok) {
      throw new FellowApiError(
        `Failed to toggle schedule ${scheduleId}`,
        r.status,
        await r.text(),
      );
    }
  }
}

export interface FellowSchedule {
  id?: string;
  /** 7 booleans, Sunday through Saturday */
  days: boolean[];
  /** seconds since midnight in the device's local time, 0–86399 */
  secondFromStartOfTheDay: number;
  enabled: boolean;
  /** brew volume in milliliters, 150–1500 */
  amountOfWater: number;
  /** profile id, must match /^(p|plocal)\d+$/ */
  profileId: string;
}
