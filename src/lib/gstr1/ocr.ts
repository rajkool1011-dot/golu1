// OCR fallback for scanned/image-based PDFs.
// Renders each PDF page to a canvas, then runs Tesseract on the raster.

export async function ocrPdf(
  file: File,
  onProgress?: (msg: string) => void,
): Promise<string> {
  const [pdfjsLib, worker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]);
  (pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
    worker.default;

  const buf = await file.arrayBuffer();
  const pdf = await (pdfjsLib as any).getDocument({
    data: buf,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;

  const Tesseract = (await import("tesseract.js")).default;
  const tWorker = await Tesseract.createWorker("eng", 1, {
    logger: (m: { status: string; progress: number }) => {
      if (onProgress && m.status) {
        onProgress(`OCR ${m.status} ${Math.round((m.progress || 0) * 100)}%`);
      }
    },
  });

  const out: string[] = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      await page.render({ canvasContext: ctx, viewport, canvas } as any).promise;
      onProgress?.(`OCR page ${i}/${pdf.numPages}`);
      const { data } = await tWorker.recognize(canvas);
      if (data.text) out.push(data.text);
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    await tWorker.terminate();
  }
  return out.join("\n");
}
