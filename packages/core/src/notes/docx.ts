import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { marked, type Token, type Tokens } from 'marked';

import { splitFrontmatter } from './parse';

/**
 * Markdown → DOCX, for the person who has to send a document.
 *
 * Built over `marked`'s lexer — the same parser the HTML export uses — so the
 * two formats can never disagree about the structure of a note. The mapping is
 * deliberately plain: headings, paragraphs, inline emphasis and code, links,
 * lists, quotes, code blocks, tables and rules. Word is the destination, not a
 * rendering target to be pixel-faithful to.
 */

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

const MONO = { name: 'Consolas' } as const;

interface InlineStyle {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
}

type Inline = TextRun | ExternalHyperlink;

/** Flatten marked's inline token tree into styled runs. */
function inlineRuns(tokens: Token[] | undefined, style: InlineStyle = {}): Inline[] {
  if (!tokens) return [];
  const runs: Inline[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const inner = (token as Tokens.Text).tokens;
        if (inner && inner.length > 0) runs.push(...inlineRuns(inner, style));
        else runs.push(new TextRun({ text: token.text ?? token.raw, ...style }));
        break;
      }
      case 'strong':
        runs.push(...inlineRuns((token as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        runs.push(...inlineRuns((token as Tokens.Em).tokens, { ...style, italics: true }));
        break;
      case 'del':
        runs.push(...inlineRuns((token as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case 'codespan':
        runs.push(new TextRun({ text: (token as Tokens.Codespan).text, font: MONO, ...style }));
        break;
      case 'link': {
        const link = token as Tokens.Link;
        runs.push(
          new ExternalHyperlink({
            link: link.href,
            children: [new TextRun({ text: link.text || link.href, style: 'Hyperlink' })],
          }),
        );
        break;
      }
      case 'image': {
        // Fetching and embedding image bytes is the HTML export's job; here
        // the alt text keeps the document readable.
        const image = token as Tokens.Image;
        runs.push(new TextRun({ text: image.text ? `[${image.text}]` : '[image]', ...style }));
        break;
      }
      case 'br':
        runs.push(new TextRun({ break: 1 }));
        break;
      case 'escape':
        runs.push(new TextRun({ text: (token as Tokens.Escape).text, ...style }));
        break;
      default:
        runs.push(new TextRun({ text: token.raw ?? '', ...style }));
    }
  }

  return runs;
}

type Block = Paragraph | Table;

function listBlocks(list: Tokens.List, depth: number): Block[] {
  const blocks: Block[] = [];
  let ordinal = typeof list.start === 'number' && list.start > 0 ? list.start : 1;

  for (const item of list.items) {
    const marker = list.ordered ? `${ordinal}. ` : item.task ? (item.checked ? '☑ ' : '☐ ') : '• ';
    ordinal += 1;

    // The item's own text is its first paragraph; nested lists follow.
    const inline: Token[] = [];
    const nested: Block[] = [];
    for (const child of item.tokens) {
      if (child.type === 'list') nested.push(...listBlocks(child as Tokens.List, depth + 1));
      else if (child.type === 'text' || child.type === 'paragraph') {
        inline.push(...((child as Tokens.Text).tokens ?? [child]));
      }
    }

    blocks.push(
      new Paragraph({
        children: [new TextRun({ text: marker }), ...inlineRuns(inline)],
        indent: { left: 360 * (depth + 1) },
        spacing: { after: 60 },
      }),
    );
    blocks.push(...nested);
  }

  return blocks;
}

function tableBlock(token: Tokens.Table): Table {
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' };
  const borders = { top: border, bottom: border, left: border, right: border };

  const row = (cells: Tokens.TableCell[], header: boolean) =>
    new TableRow({
      children: cells.map(
        (cell) =>
          new TableCell({
            borders,
            children: [
              new Paragraph({
                children: inlineRuns(cell.tokens, header ? { bold: true } : {}),
                alignment:
                  cell.align === 'center'
                    ? AlignmentType.CENTER
                    : cell.align === 'right'
                      ? AlignmentType.RIGHT
                      : AlignmentType.LEFT,
              }),
            ],
          }),
      ),
    });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [row(token.header, true), ...token.rows.map((cells) => row(cells, false))],
  });
}

function blocksFor(tokens: Token[]): Block[] {
  const blocks: Block[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading;
        blocks.push(
          new Paragraph({
            heading: HEADINGS[Math.min(heading.depth, 6) - 1],
            children: inlineRuns(heading.tokens),
          }),
        );
        break;
      }
      case 'paragraph':
        blocks.push(
          new Paragraph({
            children: inlineRuns((token as Tokens.Paragraph).tokens),
            spacing: { after: 120 },
          }),
        );
        break;
      case 'list':
        blocks.push(...listBlocks(token as Tokens.List, 0));
        break;
      case 'blockquote':
        // Quotes render as indented italic paragraphs; nested structure inside
        // a quote flattens to its text, which is what quoting usually means.
        for (const inner of (token as Tokens.Blockquote).tokens) {
          if (inner.type === 'paragraph') {
            blocks.push(
              new Paragraph({
                children: inlineRuns((inner as Tokens.Paragraph).tokens, { italics: true }),
                indent: { left: 360 },
                spacing: { after: 120 },
              }),
            );
          } else {
            blocks.push(...blocksFor([inner]));
          }
        }
        break;
      case 'code':
        for (const line of ((token as Tokens.Code).text ?? '').split('\n')) {
          blocks.push(
            new Paragraph({
              children: [new TextRun({ text: line, font: MONO, size: 18 })],
              shading: { fill: 'F2F0EB' },
            }),
          );
        }
        break;
      case 'hr':
        blocks.push(
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' } },
          }),
        );
        break;
      case 'table':
        blocks.push(tableBlock(token as Tokens.Table));
        break;
      case 'space':
        break;
      default:
        if (token.raw?.trim()) {
          blocks.push(new Paragraph({ children: [new TextRun({ text: token.raw.trim() })] }));
        }
    }
  }

  return blocks;
}

/** A note as a `.docx`, base64-encoded so it can cross the IPC as a string. */
export async function exportNoteToDocx(source: string, title: string): Promise<string> {
  const { body } = splitFrontmatter(source);
  // Wikilinks flatten to their text, exactly as the single-file HTML export does.
  const withoutWikiLinks = body.replace(
    /\[\[([^\]|#\n]+)(?:#[^\]|\n]+)?(?:\|([^\]\n]+))?\]\]/g,
    (_whole, target: string, alias: string | undefined) => alias ?? target,
  );

  const tokens = marked.lexer(withoutWikiLinks, { gfm: true });
  const document = new Document({
    title,
    sections: [{ children: blocksFor(tokens) }],
  });

  return Packer.toBase64String(document);
}
