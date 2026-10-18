// Server-side document text extraction.
// - Accepts .txt, .pdf and photos (.jpg/.png/.webp), max 4 MB, as multipart form-data.
// - Digital PDFs are read with pdf-parse. Scanned PDFs and photos of prescriptions
//   are read by Gemini (OCR) when GEMINI_API_KEY is configured.
// - Nothing is written to disk or stored. The buffer is discarded after parsing.

import { NextResponse } from "next/server";
import { callGemini, getGeminiKey } from "@/lib/carebridge/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 4 * 1024 * 1024; // Vercel request bodies are limited to about 4.5 MB

const OCR_SYSTEM = [
  "You are an OCR engine for medical documents (prescriptions, discharge summaries, lab slips).",
  "Transcribe ALL text in the document exactly as written, in reading order, as plain text.",
  "Keep medicine names, strengths, doses, frequencies, durations, dates and numbers EXACTLY as they appear.",
  "If a word or number is unreadable write [illegible]. Never guess, correct, or add anything.",
  "Do not summarise or explain. Output the plain text only.",
].join("\n");

function imageMime(lower: string, type: string): string | null {
  if (type === "image/png" || lower.endsWith(".png")) return "image/png";
  if (type === "image/jpeg" || lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (type === "image/webp" || lower.endsWith(".webp")) return "image/webp";
  return null;
}

async function ocrWithGemini(buf: Buffer, mimeType: string) {
  return callGemini({
    system: OCR_SYSTEM,
    parts: [{ text: "Transcribe this document." }, { inlineData: { mimeType, data: buf.toString("base64") } }],
    json: false,
    maxTokens: 8192,
    temperature: 0,
  });
}

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "Could not read the uploaded form data." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: "No file was provided." }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ ok: false, error: "The file is empty. Please choose a file with content." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: "File is too large. Please upload a file up to 4 MB." }, { status: 413 });
  }

  const name = file.name || "document";
  const lower = name.toLowerCase();
  const isPdf = lower.endsWith(".pdf") || file.type === "application/pdf";
  const img = imageMime(lower, file.type);
  const isTxt = !isPdf && !img && (lower.endsWith(".txt") || file.type.startsWith("text/"));

  try {
    if (isTxt) {
      const text = await file.text();
      if (!text.trim()) {
        return NextResponse.json({ ok: false, error: "The text file contains no readable text." }, { status: 400 });
      }
      return NextResponse.json({ ok: true, name, kind: "txt", text, pages: null, ocr: false });
    }

    if (isPdf) {
      const buf = Buffer.from(await file.arrayBuffer());
      let text = "";
      let pages: number | null = null;
      try {
        const mod = (await import("pdf-parse/lib/pdf-parse.js")) as unknown as {
          default: (b: Buffer, o?: Record<string, unknown>) => Promise<{ text: string; numpages: number }>;
        };
        const result = await mod.default(buf, { max: 20 });
        text = (result.text ?? "").trim();
        pages = result.numpages ?? null;
      } catch {
        text = "";
      }
      if (text.length >= 40) {
        return NextResponse.json({ ok: true, name, kind: "pdf", text, pages, ocr: false });
      }
      // Scanned / photographed PDF: ask Gemini to read it.
      if (getGeminiKey()) {
        const out = await ocrWithGemini(buf, "application/pdf");
        if (out.ok) return NextResponse.json({ ok: true, name, kind: "pdf", text: out.text.trim(), pages, ocr: true });
        return NextResponse.json({ ok: false, error: out.error }, { status: out.code === "quota" ? 429 : 502 });
      }
      return NextResponse.json(
        {
          ok: false,
          error:
            "No extractable text was found in this PDF (it looks scanned). Add GEMINI_API_KEY on the server so AI can read it, or paste the text instead.",
        },
        { status: 422 },
      );
    }

    if (img) {
      if (!getGeminiKey()) {
        return NextResponse.json(
          { ok: false, error: "Reading photos needs the Gemini API key. Add GEMINI_API_KEY in Vercel and redeploy, or paste the text instead." },
          { status: 422 },
        );
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const out = await ocrWithGemini(buf, img);
      if (out.ok) return NextResponse.json({ ok: true, name, kind: "image", text: out.text.trim(), pages: null, ocr: true });
      return NextResponse.json({ ok: false, error: out.error }, { status: out.code === "quota" ? 429 : 502 });
    }

    return NextResponse.json(
      { ok: false, error: "Unsupported file type. Please upload a PDF, a photo (JPG/PNG), or a .txt file, or paste the text directly." },
      { status: 415 },
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: "We could not read that file. Please try another file or paste the text directly." },
      { status: 422 },
    );
  }
}
