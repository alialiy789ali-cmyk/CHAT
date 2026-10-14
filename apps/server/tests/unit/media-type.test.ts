/**
 * Content sniffing.
 *
 * The point of these tests is not that the sniffer recognises every format in the world — it is that
 * a *declared* type never gets the last word. A PNG announced as a text file, a text file announced as
 * a PNG, or an executable announced as an image must all be refused, while the declarations that are
 * honestly the same content (docx is a zip, Opus is in Ogg) must still be accepted.
 */
import { describe, expect, it } from 'vitest';
import { detectMediaType, isTypeConsistent } from '../../src/lib/media-type.js';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const text = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'utf8'));

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46);
const GIF = text('GIF89a....');
const WEBP = Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]);
const WAV = Uint8Array.from([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WAVE')]);
const PDF = text('%PDF-1.7\n...');
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
/** A docx is a zip archive with a manifest inside — the bytes start like any zip. */
const ZIP_DOCX = ZIP;
const OGG = Uint8Array.from([...Buffer.from('OggS'), 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
const OGG_OPUS = Uint8Array.from([...Buffer.from('OggS'), 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, ...Buffer.from('OpusHead'), 1, 2]);
const WEBM = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00);
const MP3 = Uint8Array.from([...Buffer.from('ID3'), 4, 0, 0, 0, 0, 0, 0]);
const FTYP = (brand: string): Uint8Array =>
  Uint8Array.from([0, 0, 0, 0x18, ...Buffer.from('ftyp'), ...Buffer.from(brand), 0, 0, 0, 0]);

describe('detectMediaType', () => {
  it('recognises the formats the platform accepts', () => {
    expect(detectMediaType(PNG)).toBe('image/png');
    expect(detectMediaType(JPEG)).toBe('image/jpeg');
    expect(detectMediaType(GIF)).toBe('image/gif');
    expect(detectMediaType(WEBP)).toBe('image/webp');
    expect(detectMediaType(WAV)).toBe('audio/wav');
    expect(detectMediaType(PDF)).toBe('application/pdf');
    expect(detectMediaType(ZIP)).toBe('application/zip');
    expect(detectMediaType(OGG)).toBe('audio/ogg');
    expect(detectMediaType(OGG_OPUS)).toBe('audio/opus');
    expect(detectMediaType(WEBM)).toBe('video/webm');
    expect(detectMediaType(MP3)).toBe('audio/mpeg');
    expect(detectMediaType(FTYP('avif'))).toBe('image/avif');
    expect(detectMediaType(FTYP('qt  '))).toBe('video/quicktime');
    expect(detectMediaType(FTYP('M4A '))).toBe('audio/mp4');
    expect(detectMediaType(FTYP('isom'))).toBe('video/mp4');
  });

  it('treats human-readable bytes as text and refuses what it cannot place', () => {
    expect(detectMediaType(text('{"hello":"world"}'))).toBe('text/plain');
    expect(detectMediaType(text('# a markdown file\n\n- item'))).toBe('text/plain');
    // A compiled binary: not text (NULs), not any accepted signature.
    expect(detectMediaType(bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x00, 0x01))).toBeNull();
    expect(detectMediaType(new Uint8Array(0))).toBeNull();
  });

  it('does not confuse a PNG with the text file that claims to be one', () => {
    expect(detectMediaType(PNG)).not.toBe('text/plain');
    expect(isTypeConsistent('text/plain', detectMediaType(PNG))).toBe(false);
  });
});

describe('isTypeConsistent', () => {
  it('accepts an exact match', () => {
    expect(isTypeConsistent('image/png', 'image/png')).toBe(true);
  });

  it('accepts declarations that describe the same content under another name', () => {
    // Office documents are zip archives.
    expect(isTypeConsistent('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip')).toBe(true);
    expect(detectMediaType(ZIP_DOCX)).toBe('application/zip');
    // Opus lives in an Ogg container.
    expect(isTypeConsistent('audio/opus', 'audio/ogg')).toBe(true);
    // An audio-only WebM is still a WebM.
    expect(isTypeConsistent('audio/webm', 'video/webm')).toBe(true);
    // Text formats have no signature at all.
    expect(isTypeConsistent('application/json', 'text/plain')).toBe(true);
  });

  it('refuses a mismatch, including the classic attacks', () => {
    // A script or binary announced as an image.
    expect(isTypeConsistent('image/png', 'text/plain')).toBe(false);
    expect(isTypeConsistent('image/jpeg', null)).toBe(false);
    // A PNG announced as a text file (or as a PDF) is not what it says it is.
    expect(isTypeConsistent('text/plain', 'image/png')).toBe(false);
    expect(isTypeConsistent('application/pdf', 'image/png')).toBe(false);
  });
});
