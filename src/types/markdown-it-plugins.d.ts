declare module 'markdown-it-footnote' {
  import type { MarkdownIt } from 'markdown-it';
  const footnote: (md: MarkdownIt) => void;
  export default footnote;
}

declare module 'markdown-it-emoji' {
  import type { MarkdownIt } from 'markdown-it';
  interface EmojiOptions {
    defs?: Record<string, string>;
    enabled?: string[];
    shortcuts?: Record<string, string | string[]>;
  }
  export const full: (md: MarkdownIt, options?: EmojiOptions) => void;
  export const light: (md: MarkdownIt, options?: EmojiOptions) => void;
  export const bare: (md: MarkdownIt, options?: EmojiOptions) => void;
}
