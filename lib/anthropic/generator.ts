/**
 * The generation seam, kept free of any server-only import so the report
 * pipeline can be exercised end to end without a network call or an API key.
 * The concrete Anthropic-backed implementation lives in ./client.
 */

export type GenerateParams = {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
  /** Seeds the assistant turn, e.g. '{' to force a JSON continuation. */
  prefill?: string;
};

export interface Generator {
  generate(params: GenerateParams): Promise<string>;
}

/**
 * Parse a JSON object out of a model response. Models wrap JSON in prose or
 * fences often enough that failing on it is not an option; failing loudly when
 * there is genuinely no object is.
 */
export function parseJsonObject<T>(raw: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();

  try {
    return JSON.parse(candidate) as T;
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as T;
    }
    throw new Error(`Expected a JSON object in the model response, got: ${raw.slice(0, 200)}`);
  }
}
