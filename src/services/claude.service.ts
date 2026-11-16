import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod';
import { config } from '../config';
import { UserError } from '../errors';
import type { SourceSnapshot } from '../models/Product';
import type { Settings } from '../models/Settings';
import { clip } from './mapper';

/** What Claude returns. "" means "not applicable". Lengths are enforced after the call. */
const DraftSchema = z.object({
  title: z.string(),
  description: z.string(),
  googleProductCategory: z.string(),
  productType: z.string(),
  productHighlights: z.array(z.string()),
  color: z.string(),
  size: z.string(),
  material: z.string(),
  policyRisk: z.string(),
});
export type Draft = z.infer<typeof DraftSchema> & { model: string };

const SYSTEM = `You write Google Merchant Center product listings for a small online store.
You receive one product variant from the store's Whop catalog as JSON and return the listing fields.

Rules:
- title: at most 150 characters. Start with what the product is, then the attributes a shopper filters by (color, size, material). No promotional text ("free shipping", "sale", "best"), no ALL CAPS words, no emoji, no prices.
- description: plain text, ideally 300-1500 characters; shorter is fine when the input has little information. Use only facts from the input. No links, HTML, promotional text or comparisons with other brands.
- googleProductCategory: the full Google product taxonomy path that fits best, for example "Home & Garden > Lighting > Lamps".
- productType: the store's own category path, for example "Lighting > Table Lamps".
- productHighlights: 3-6 short factual points, each under 150 characters.
- color, size, material: fill in only when the input states them, otherwise "".
- policyRisk: "" when you see no Google Shopping policy problem. Otherwise one or two sentences naming the risk (for example digital goods, services, recurring subscriptions, restricted products, health claims, or information a shopper needs that is missing).
Never invent specifications, dimensions, materials or certifications that are not in the input. Write in the language given as "language".`;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    try {
      client = new Anthropic(); // reads ANTHROPIC_API_KEY
    } catch (e) {
      throw new UserError(`Claude is not set up: ${e instanceof Error ? e.message : String(e)}`, 500);
    }
  }
  return client;
}

export async function draftListing(s: SourceSnapshot, settings: Settings): Promise<Draft> {
  const input = {
    language: settings.contentLanguage,
    targetCountry: settings.feedLabel,
    brand: settings.brand || null,
    product: {
      title: s.productTitle,
      variant: s.variantTitle,
      headline: s.headline,
      description: s.description,
      options: s.attributes,
      sku: s.sku,
      price: `${s.price} ${s.currency}`,
    },
  };

  let response;
  try {
    response = await getClient().beta.messages.parse({
      model: config.claudeModel,
      max_tokens: 16000,
      // If the model declines for policy reasons, the API retries on its default fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'medium', format: betaZodOutputFormat(DraftSchema) },
      messages: [{ role: 'user', content: JSON.stringify(input, null, 2) }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new UserError('Claude rejected the API key. Check ANTHROPIC_API_KEY.', 500);
    if (e instanceof Anthropic.RateLimitError) throw new UserError('Claude is rate limiting requests. Try again in a minute.', 429);
    throw e;
  }

  if (response.stop_reason === 'refusal') {
    const why = response.stop_details?.explanation;
    throw new UserError(`Claude declined to draft this listing${why ? `: ${why}` : '.'}`, 422);
  }
  if (response.stop_reason === 'max_tokens') throw new Error('Claude stopped before finishing the listing (max_tokens).');
  const out = response.parsed_output;
  if (!out) throw new Error('Claude returned a listing in an unexpected format.');

  return {
    ...out,
    title: clip(out.title.trim(), 150),
    description: clip(out.description.trim(), 5000),
    productHighlights: out.productHighlights
      .map((h) => clip(h.trim(), 150))
      .filter(Boolean)
      .slice(0, 10),
    model: response.model,
  };
}
