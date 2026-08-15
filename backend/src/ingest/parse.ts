import * as cheerio from 'cheerio';

/**
 * Project Gutenberg HTML -> ordered sections.
 *
 * Both books mark section boundaries with <h2>, but the markup differs:
 *   Little Women:      <h2>I. Playing Pilgrims.</h2>
 *   Pride & Prejudice: <h2><a id="Chapter_I"></a><span class="pagenum">…</span>CHAPTER I.</h2>
 *
 * So we normalise on the *structural* signal (h2 boundaries) rather than on any
 * per-book title regex. See DECISIONS.md D-02.
 */

export interface Section {
  index: number;       // 0-based position among real sections
  title: string;       // e.g. "I. Playing Pilgrims." / "CHAPTER I."
  paragraphs: string[];
  wordCount: number;
}

/** Nav/front-matter sections (Contents, Illustrations) have almost no prose. */
const MIN_SECTION_WORDS = 200;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Chapter headings are split across elements, so the text join can produce
 * "CHAPTERXXVIII." with no space. Restore the boundary between a word and a
 * following capitalised run or numeral.
 */
const fixHeading = (t: string) =>
  squash(t)
    .replace(/\b(CHAPTER|Chapter|SECTION|Section)(?=[A-Z0-9])/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();

export function parseBook(html: string): Section[] {
  const $ = cheerio.load(html);

  // Gutenberg licence boilerplate is not part of the work.
  $('#pg-header, #pg-footer').remove();

  // Drop caps are IMAGES carrying the letter in alt text:
  //   <p class="nind"><span class="letra"><img alt="N" src="i_039_b.png"></span>OT all that…
  // Removing images without recovering the alt silently decapitates the first
  // word of many chapters ("OT all that Mrs. Bennet"). Substitute the letter
  // before images are stripped below.
  $('img[alt]').each((_, el) => {
    const alt = ($(el).attr('alt') ?? '').trim();
    if (/^[A-Za-z]$/.test(alt)) $(el).replaceWith(alt);
  });
  // Page-number markers and transcriber tables pollute prose extraction.
  $('.pagenum, .pagenumber, .figcenter, .caption, table, img, style, script').remove();

  const sections: Section[] = [];
  let current: { title: string; paragraphs: string[] } | null = null;

  // find('h2, p') yields both tag types in document order, which is exactly the
  // stream we need to segment.
  $('body')
    .find('h2, p')
    .each((_, el) => {
      const tag = (el as { tagName?: string }).tagName?.toLowerCase();
      const text = squash($(el).text());
      if (tag === 'h2') {
        if (current) sections.push(finalise(current, sections.length));
        current = { title: fixHeading(text) || 'Front matter', paragraphs: [] };
      } else if (current && text) {
        current.paragraphs.push(text);
      }
    });
  if (current) sections.push(finalise(current, sections.length));

  const indexed = sections
    .filter((s) => s.wordCount >= MIN_SECTION_WORDS)
    .map((s, i) => ({ ...s, index: i }));

  // Only the work itself reaches the index. What this removes is not
  // boilerplate: Pride and Prejudice ships with George Saintsbury's 1894
  // critical introduction, seventeen chunks of literary criticism written in
  // exactly the register an editor's thematic question is phrased in, so it
  // won the top two ranks for "what is distinctive about the humour in this
  // book" and took seven of ten results. Every guardrail passed it, because it
  // really is in the corpus. It is simply not the novel. See D-84.
  //
  // Indices are assigned BEFORE this filter and kept, so removing a section
  // renumbers nothing: chunk ids are `book:chapterIndex:n` and every surviving
  // id is unchanged. The earlier note claiming this would invalidate 120 eval
  // cases assumed a filter that re-indexed, and was never tested.
  const titles = indexed.map((s) => s.title);
  return indexed.filter((s) => isNumberedChapter(s.title, titles));
}

/**
 * Is this section part of the work, or apparatus around it?
 *
 * Both books number their chapters, so a title carrying no numeral in a book
 * where almost every title does is front or back matter: "Front matter",
 * "Transcriber's Notes", "The Works of Louisa May Alcott". The 0.7 threshold is
 * the escape hatch for a book that does not number its chapters at all, where
 * the rule would otherwise discard everything.
 */
export function isNumberedChapter(title: string, allTitles: string[]): boolean {
  const has = (t: string) => /\b([IVXLC]+|\d+)\b/i.test(t);
  const numbered = allTitles.filter(has).length >= allTitles.length * 0.7;
  return numbered ? has(title) : true;
}

function finalise(s: { title: string; paragraphs: string[] }, index: number): Section {
  const wordCount = s.paragraphs.reduce((n, p) => n + p.split(/\s+/).length, 0);
  return { index, title: s.title, paragraphs: s.paragraphs, wordCount };
}
