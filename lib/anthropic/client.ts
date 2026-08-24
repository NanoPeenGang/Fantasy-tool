import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import type { GenerateParams, Generator } from './generator';

/**
 * Thin wrapper over the Anthropic SDK. Everything the report pipeline needs is
 * a system prompt plus one user turn, so the surface stays small.
 *
 * The `Generator` interface and `parseJsonObject` live in ./generator, which
 * carries no server-only import — that is what lets the pipeline be tested
 * against a scripted generator.
 */

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  client = new Anthropic({ apiKey });
  return client;
}

export const DEFAULT_MODEL = process.env.LEAGUEOPS_MODEL ?? 'claude-sonnet-4-5';

export class AnthropicGenerator implements Generator {
  constructor(private readonly model: string = DEFAULT_MODEL) {}

  async generate(params: GenerateParams): Promise<string> {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: params.user }];
    if (params.prefill) messages.push({ role: 'assistant', content: params.prefill });

    const response = await anthropic().messages.create({
      model: params.model ?? this.model,
      max_tokens: params.maxTokens ?? 4096,
      temperature: params.temperature ?? 1,
      system: params.system,
      messages,
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    // A prefill is part of the assistant turn, so the caller gets it back
    // stitched on: otherwise every JSON response arrives missing its brace.
    return params.prefill ? params.prefill + text : text;
  }
}

export { parseJsonObject } from './generator';
export type { GenerateParams, Generator } from './generator';
