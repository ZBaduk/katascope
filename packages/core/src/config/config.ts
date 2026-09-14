/**
 * Shape and validation of `katascope.config.json`.
 *
 * Pure: this module never touches the filesystem. Loading is the Node side's
 * job (`@katascope/katago-bridge`); parsing and validating the JSON lives here
 * so the renderer can reason about the same type.
 */

export interface KatascopeConfig {
  /** Absolute path to the `katago` executable. */
  readonly katagoPath: string;
  /** Absolute path to the model file (`.bin.gz` / `.txt.gz`). */
  readonly modelPath: string;
  /** Absolute path to the KataGo analysis config (`analysis_example.cfg` or similar). */
  readonly katagoConfigPath: string;
  /** Python interpreter used to run the activation sidecar. */
  readonly pythonPath: string;
  /** Sidecar entry point. Relative paths resolve against the config file's directory. */
  readonly sidecarPath: string;
  /**
   * When true, the app never spawns anything and serves synthetic data from
   * `FakeActivationStore`. This is the default so a fresh clone runs.
   */
  readonly useFakes: boolean;
}

export const DEFAULT_CONFIG: KatascopeConfig = {
  katagoPath: 'katago',
  modelPath: '',
  katagoConfigPath: '',
  pythonPath: 'python3',
  sidecarPath: 'sidecar/activations.py',
  useFakes: true,
};

export interface ConfigProblem {
  readonly field: keyof KatascopeConfig | '(root)';
  readonly message: string;
}

export interface ConfigParseResult {
  readonly config: KatascopeConfig;
  /** Non-fatal issues. A config with problems still yields a usable object. */
  readonly problems: readonly ConfigProblem[];
}

/**
 * Merges unknown JSON over the defaults. Unknown keys are ignored and wrongly
 * typed values fall back to their default, each reported as a problem -- a bad
 * config should surface in Diagnostics, not crash the app at startup.
 */
export function parseConfig(input: unknown): ConfigParseResult {
  const problems: ConfigProblem[] = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      config: DEFAULT_CONFIG,
      problems: [{ field: '(root)', message: 'config must be a JSON object; using defaults' }],
    };
  }
  const raw = input as Record<string, unknown>;

  const str = (field: keyof KatascopeConfig, fallback: string): string => {
    const value = raw[field];
    if (value === undefined) return fallback;
    if (typeof value !== 'string') {
      problems.push({ field, message: `expected a string, got ${typeName(value)}; using "${fallback}"` });
      return fallback;
    }
    return value;
  };

  const bool = (field: keyof KatascopeConfig, fallback: boolean): boolean => {
    const value = raw[field];
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
      problems.push({ field, message: `expected a boolean, got ${typeName(value)}; using ${fallback}` });
      return fallback;
    }
    return value;
  };

  const config: KatascopeConfig = {
    katagoPath: str('katagoPath', DEFAULT_CONFIG.katagoPath),
    modelPath: str('modelPath', DEFAULT_CONFIG.modelPath),
    katagoConfigPath: str('katagoConfigPath', DEFAULT_CONFIG.katagoConfigPath),
    pythonPath: str('pythonPath', DEFAULT_CONFIG.pythonPath),
    sidecarPath: str('sidecarPath', DEFAULT_CONFIG.sidecarPath),
    useFakes: bool('useFakes', DEFAULT_CONFIG.useFakes),
  };

  return { config, problems: [...problems, ...validateConfig(config)] };
}

/**
 * Checks a config for internal consistency. Does not stat any path -- existence
 * is checked by the bridge, which can actually reach the filesystem.
 */
export function validateConfig(config: KatascopeConfig): readonly ConfigProblem[] {
  if (config.useFakes) return [];
  const problems: ConfigProblem[] = [];
  for (const field of ['katagoPath', 'modelPath', 'katagoConfigPath', 'pythonPath', 'sidecarPath'] as const) {
    if (config[field].trim() === '') {
      problems.push({ field, message: 'must be set when useFakes is false' });
    }
  }
  return problems;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}
