export type ProviderCli = "claude-code" | "codex";
export type ProviderBillingMode = "subscription" | "metered";

const COMMON_RUNTIME_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

const PROVIDER_CONFIG_KEYS: Readonly<Record<ProviderCli, readonly string[]>> = {
  "claude-code": ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH"],
  codex: ["CODEX_HOME"],
};

const PROVIDER_AUTH_KEYS: Readonly<
  Record<ProviderCli, Readonly<Record<ProviderBillingMode, readonly string[]>>>
> = {
  "claude-code": {
    subscription: ["CLAUDE_CODE_OAUTH_TOKEN"],
    metered: ["ANTHROPIC_API_KEY"],
  },
  codex: {
    subscription: [],
    metered: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  },
};

/**
 * Builds a fail-closed environment for provider CLIs. Keys for unrelated cloud,
 * source-control, package-registry, and shell credentials are intentionally absent.
 */
export function providerProcessEnvironment(
  provider: ProviderCli,
  billingMode: ProviderBillingMode,
  source: Readonly<Record<string, string | undefined>> = process.env,
  includeAuthentication = true,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const key of [
    ...COMMON_RUNTIME_KEYS,
    ...PROVIDER_CONFIG_KEYS[provider],
    ...(includeAuthentication ? PROVIDER_AUTH_KEYS[provider][billingMode] : []),
  ]) {
    const value = environmentValue(source, key);
    if (value !== undefined && !value.includes("\0")) result[key] = value;
  }
  return result;
}

function environmentValue(
  source: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const exact = source[key];
  if (exact !== undefined || process.platform !== "win32") return exact;
  const matchingKey = Object.keys(source).find(
    (candidate) => candidate.toLocaleUpperCase("en-US") === key.toLocaleUpperCase("en-US"),
  );
  return matchingKey ? source[matchingKey] : undefined;
}
