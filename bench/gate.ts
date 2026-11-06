// The corpus gate of a release: on Linux, every entry keeps wkhtmltopdf's
// exit code and page count, and at least 99 % of the words found in both
// PDFs stay on the same page, the corpus as a whole. Elsewhere the figures
// are an indicator: on Windows, wkhtmltopdf's Qt takes its font metrics
// from GDI and draws its text larger. node dist/bench/compat.js --gate
// applies it.
export const MIN_SAME_PAGE = 0.99;

export interface GateRow {
  id: string;
  exit?: { wkhtmltopdf: number | null; pdfkiln: number | null };
  pages?: { wkhtmltopdf: number; pdfkiln: number };
  comparison?: { same_page: { matched: number; same_page: number } };
}

// What misses the gate, one line each; none when it passes.
export function gateFailures(rows: GateRow[]): string[] {
  const failures: string[] = [];
  if (!rows.length) failures.push('no entry compared');
  for (const r of rows) {
    if (r.exit && r.exit.pdfkiln !== r.exit.wkhtmltopdf) failures.push(`${r.id}: exit ${r.exit.pdfkiln}, wkhtmltopdf ${r.exit.wkhtmltopdf}`);
    if (!r.pages || !r.comparison) failures.push(`${r.id}: no PDF to compare`);
    else if (r.pages.pdfkiln !== r.pages.wkhtmltopdf) failures.push(`${r.id}: ${r.pages.pdfkiln} pages, wkhtmltopdf ${r.pages.wkhtmltopdf}`);
  }
  let matched = 0;
  let same = 0;
  for (const r of rows) {
    if (!r.comparison) continue;
    matched += r.comparison.same_page.matched;
    same += r.comparison.same_page.same_page * r.comparison.same_page.matched;
  }
  if (matched && same / matched < MIN_SAME_PAGE) {
    failures.push(`${((100 * same) / matched).toFixed(2)} % of the matched words on the same page, under ${MIN_SAME_PAGE * 100} %`);
  }
  return failures;
}
