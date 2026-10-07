#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const docsDir = path.join(__dirname, '..', 'docs');
const quickStartPath = path.join(docsDir, 'AIRI-QA-QUICK-START.md');
const teamGuidePath = path.join(docsDir, 'AIRI-QA-TEAM-GUIDE.md');
const outputPath = path.join(docsDir, 'AIRI-QA-TRAINING-USER-GUIDE.docx');
const htmlPath = path.join(os.tmpdir(), `airi-qa-training-guide-${process.pid}.html`);

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function markdownToHtml(markdown) {
  const lines = markdown
    .replace(/```mermaid[\s\S]*?```/g, '> Recordings and HubSpot details feed AIRI QA. Reviews and forwarding results are saved for team follow-up.')
    .split(/\r?\n/);
  const output = [];
  let paragraph = [];
  let list = '';
  let tableOpen = false;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!list) return;
    output.push(`</${list}>`);
    list = '';
  };
  const closeTable = () => {
    if (!tableOpen) return;
    output.push('</tbody></table>');
    tableOpen = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      closeList();
      closeTable();
      continue;
    }
    if (/^\|.*\|$/.test(line)) {
      flushParagraph();
      closeList();
      if (/^\|[\s|:-]+\|$/.test(line)) continue;
      const cells = line.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
      if (!tableOpen) {
        output.push(`<table><thead><tr>${cells.map(cell => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>`);
        tableOpen = true;
      } else {
        output.push(`<tr>${cells.map(cell => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`);
      }
      continue;
    }
    closeTable();
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const numbered = line.match(/^\d+\.\s+(.+)$/);
    if (bullet || numbered) {
      flushParagraph();
      const nextList = bullet ? 'ul' : 'ol';
      if (list !== nextList) {
        closeList();
        output.push(`<${nextList}>`);
        list = nextList;
      }
      output.push(`<li>${inlineMarkdown((bullet || numbered)[1])}</li>`);
      continue;
    }
    closeList();
    if (line.startsWith('> ')) {
      flushParagraph();
      output.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`);
      continue;
    }
    paragraph.push(line);
  }

  flushParagraph();
  closeList();
  closeTable();
  return output.join('\n');
}

function main() {
  if (process.platform !== 'darwin') {
    throw new Error('Training guide export requires macOS textutil. Run this from the Mac deployment workstation.');
  }
  const quickStart = fs.readFileSync(quickStartPath, 'utf8');
  const teamGuide = fs.readFileSync(teamGuidePath, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>AIRI QA Training &amp; User Guide</title><style>
body{font-family:Arial,sans-serif;color:#17202a;line-height:1.45;font-size:11pt;max-width:780px;margin:40px auto;padding:0 32px}
h1{font-size:24pt;color:#1769aa;border-bottom:2px solid #25a9d2;padding-bottom:8px}h2{font-size:17pt;color:#1769aa;margin-top:24px}h3{font-size:13pt;color:#34495e}
li,p{margin:7px 0}ul,ol{padding-left:26px}table{border-collapse:collapse;width:100%;margin:12px 0;font-size:10pt}td,th{border:1px solid #cbd5df;padding:7px;text-align:left;vertical-align:top}th{background:#eaf4f8}
blockquote{border-left:4px solid #25a9d2;padding:8px 14px;background:#f3f8fa}code{font-family:Menlo,monospace;background:#f1f3f5;padding:1px 3px}.cover{margin:75px 0 50px}.subtitle{font-size:14pt;color:#506273}hr{border:0;border-top:1px solid #cbd5df;margin:30px 0}
</style></head><body><section class="cover"><h1>AIRI QA Training &amp; User Guide</h1><p class="subtitle">A practical guide for reviewers, admins, and trainers</p><p>Plain-language instructions first, followed by the admin and bug-investigation reference.</p></section>
${markdownToHtml(quickStart)}<hr><h1>Admin And Bug-Investigation Reference</h1>${markdownToHtml(teamGuide)}</body></html>`;

  try {
    fs.writeFileSync(htmlPath, html);
    execFileSync('textutil', ['-convert', 'docx', '-output', outputPath, htmlPath], { stdio: 'inherit' });
    if (!fs.statSync(outputPath).size) throw new Error('Generated training guide is empty');
    console.log(`AIRI QA Training & User Guide generated: ${outputPath}`);
  } finally {
    try { fs.unlinkSync(htmlPath); } catch {}
  }
}

try {
  main();
} catch (error) {
  console.error(`[airi-training-guide] ${error.message}`);
  process.exitCode = 1;
}