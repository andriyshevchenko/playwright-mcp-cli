import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const SERVICE_NAME = "SecureVault";

export interface SecretSummary {
  title: string;
  category?: string;
}

export interface ProfileMapping {
  envVar: string;
  secretTitle: string;
}

export interface ProfileSummary {
  name: string;
  mappings: ProfileMapping[];
}

export interface ResolvedEntry {
  value: string;
  label: string;
}

/** Reads credentials from SecureVault (OS keychain + local JSON metadata).
 * Raw values only leave the vault to be injected into the browser — never rendered. */
export interface Vault {
  getSecretByTitle(title: string): Promise<string>;
  resolveProfile(name: string): Promise<Record<string, ResolvedEntry>>;
  listSecrets(): Promise<SecretSummary[]>;
  listProfiles(): Promise<ProfileSummary[]>;
}

interface SecretMetadata {
  id: string;
  title: string;
  category?: string;
}

interface RawProfile {
  name: string;
  mappings: { envVar: string; secretId: string }[];
}

type Keychain = { getPassword(service: string, account: string): Promise<string | null> };

function configDir(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "SecureVault");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "SecureVault");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "securevault");
}

async function loadJson<T>(filename: string): Promise<T[]> {
  try {
    const data = await readFile(join(configDir(), filename), "utf8");
    return JSON.parse(data) as T[];
  } catch {
    return [];
  }
}

/** Default vault backed by the `keytar` native OS keychain binding.
 * keytar is imported lazily so unit tests can inject a fake vault without the native module. */
export function createKeytarVault(): Vault {
  let keychainPromise: Promise<Keychain> | undefined;
  const keychain = (): Promise<Keychain> => {
    if (!keychainPromise) {
      keychainPromise = import("keytar").then((m) => (m.default ?? m) as unknown as Keychain);
    }
    return keychainPromise;
  };

  return {
    async getSecretByTitle(title) {
      const metadata = await loadJson<SecretMetadata>("metadata.json");
      const entry = metadata.find((s) => s.title === title);
      if (!entry) {
        const available = metadata.map((s) => s.title).join(", ");
        throw new Error(`Secret not found: "${title}". Available secrets: ${available}`);
      }
      const value = await (await keychain()).getPassword(SERVICE_NAME, entry.id);
      if (value === null) {
        throw new Error(`Secret "${title}" exists in metadata but has no value in the OS keychain`);
      }
      return value;
    },

    async resolveProfile(name) {
      const profiles = await loadJson<RawProfile>("profiles.json");
      const profile = profiles.find((p) => p.name === name);
      if (!profile) {
        const available = profiles.map((p) => p.name).join(", ");
        throw new Error(`Profile not found: "${name}". Available profiles: ${available}`);
      }
      const metadata = await loadJson<SecretMetadata>("metadata.json");
      const kc = await keychain();
      const resolved: Record<string, ResolvedEntry> = {};
      for (const mapping of profile.mappings) {
        const secret = await kc.getPassword(SERVICE_NAME, mapping.secretId);
        if (secret !== null) {
          const meta = metadata.find((m) => m.id === mapping.secretId);
          resolved[mapping.envVar] = { value: secret, label: meta?.title || mapping.secretId };
        }
      }
      return resolved;
    },

    async listSecrets() {
      const metadata = await loadJson<SecretMetadata>("metadata.json");
      return metadata.map((s) => ({ title: s.title, category: s.category }));
    },

    async listProfiles() {
      const profiles = await loadJson<RawProfile>("profiles.json");
      const metadata = await loadJson<SecretMetadata>("metadata.json");
      return profiles.map((p) => ({
        name: p.name,
        mappings: p.mappings.map((m) => {
          const meta = metadata.find((s) => s.id === m.secretId);
          return { envVar: m.envVar, secretTitle: meta?.title || "(unknown)" };
        }),
      }));
    },
  };
}
