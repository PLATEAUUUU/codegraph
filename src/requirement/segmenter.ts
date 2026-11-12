/**
 * Text segmentation for requirement full-text search. Wraps jieba-wasm so the
 * same tokenization runs on write (indexing) and read (query). Chinese is cut
 * by dictionary + HMM; other scripts fall out as their own tokens. jieba is
 * loaded lazily on first use.
 */

type Jieba = {
  cut(text: string, hmm?: boolean | null): string[];
  add_word(word: string, freq?: number | null, tag?: string | null): number;
};

let jieba: Jieba | null = null;

function getJieba(): Jieba {
  if (!jieba) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    jieba = require('jieba-wasm') as Jieba;
  }
  return jieba;
}

/** Segment `text` into a space-joined token string for FTS. Empty in → ''. */
export function segment(text: string | null | undefined): string {
  if (!text) return '';
  const tokens = getJieba().cut(text, true);
  return tokens.map((t) => t.trim()).filter((t) => t.length > 0).join(' ');
}

/** Add a domain term so jieba keeps it whole. Used by the custom dictionary. */
export function addTerm(word: string, freq?: number): void {
  if (!word) return;
  getJieba().add_word(word, freq ?? null, null);
}

/** Load many domain terms at once. */
export function loadUserDict(terms: Iterable<string>): void {
  for (const term of terms) addTerm(term);
}
