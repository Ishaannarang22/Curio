// Normalize the markdown a voice/LLM harness emits before it reaches the editor.
// Models are sloppy: they wrap whole replies in ```markdown fences, use • or *
// for bullets, forget the space after #, and pile on blank lines. We clean the
// common cases so the rendered doc looks intentional — without trying to be a
// full markdown linter.
export function sanitizeMarkdown(input: string): string {
  if (!input) return ''
  let md = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  // Strip a single fence that wraps the ENTIRE message (```markdown … ```),
  // which models love to add. Leave inner/legit code fences untouched.
  const fenced = md.trim().match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i)
  if (fenced) md = fenced[1]

  md = md
    .split('\n')
    .map((line) => {
      // Bullet glyphs / loose markers → '-' (skip fenced/indented code, kept as-is
      // enough for our purposes by only touching top-of-line list-like markers).
      let l = line.replace(/^(\s*)([•·▪◦])\s+/, '$1- ')
      l = l.replace(/^(\s*)\*\s+/, '$1- ') // '* item' → '- item'
      l = l.replace(/^(\s*)\+\s+/, '$1- ') // '+ item' → '- item'
      // Ensure a space after heading hashes: '##Title' → '## Title'.
      l = l.replace(/^(\s{0,3}#{1,6})([^#\s])/, '$1 $2')
      return l
    })
    .join('\n')

  // Collapse 3+ blank lines to a single blank line, trim trailing whitespace.
  md = md.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '')

  return md.trim()
}
