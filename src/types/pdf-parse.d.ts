// `pdf-parse` ships no types, and we import the inner module directly: the
// package's index.js runs a debug branch that reads a test PDF from disk when
// `module.parent` is undefined, which throws under bundlers.
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: unknown;
    version: string;
    text: string;
  }
  interface PdfParseOptions {
    max?: number;
    pagerender?: (pageData: unknown) => Promise<string>;
  }
  function pdfParse(data: Buffer | Uint8Array, options?: PdfParseOptions): Promise<PdfParseResult>;
  export = pdfParse;
}
