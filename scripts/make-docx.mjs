#!/usr/bin/env node
/**
 * Writes a minimal but genuinely valid .docx.
 *
 * A .docx is a ZIP of XML parts. Building one here (rather than committing a
 * binary produced by Word) keeps the fixture reproducible and reviewable, and
 * means the DOCX parsing path is tested against a real archive rather than a
 * mock. Entries are stored uncompressed, which the format permits.
 */
import { writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';

function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // method: stored
    local.writeUInt16LE(0, 10);           // mod time
    local.writeUInt16LE(0x21, 12);        // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);     // central directory signature
    dir.writeUInt16LE(20, 4);             // version made by
    dir.writeUInt16LE(20, 6);             // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

const xmlEscape = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildDocx(paragraphs) {
  const body = paragraphs
    .map((text) =>
      text === ''
        ? '<w:p/>'
        : `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`,
    )
    .join('');

  return zip([
    {
      name: '[Content_Types].xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'word/document.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${body}<w:sectPr/></w:body></w:document>`,
    },
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , outPath] = process.argv;
  const paragraphs = [
    'GOVT 312 — Constitutional Politics',
    'Spring 2027 · Tuesdays 2:00–4:30 PM · Baldwin Hall 210',
    'Professor E. Mbeki · office hours Thursdays 10 AM–12 PM',
    '',
    'ASSESSMENT',
    '',
    'Case Brief 1 — due Tuesday, February 2, 2027',
    'Case Brief 2 — due Tuesday, February 23, 2027',
    'Midterm Examination — Tuesday, March 9, 2027, in class',
    'Research Paper Prospectus — due Friday, March 26, 2027 by 5:00 PM',
    'Case Brief 3 — due Tuesday, April 6, 2027',
    'Oral Argument — Tuesday, April 20, 2027, Moot Court Room',
    'Final Research Paper — due Friday, May 7, 2027 by 11:59 PM',
    '',
    'GRADING',
    'Case briefs 30%, midterm 20%, oral argument 15%, research paper 35%.',
    '',
    'ATTENDANCE',
    'This is a seminar. More than two absences will affect your participation grade.',
  ];
  writeFileSync(outPath, buildDocx(paragraphs));
  console.log(`wrote ${outPath}`);
}
