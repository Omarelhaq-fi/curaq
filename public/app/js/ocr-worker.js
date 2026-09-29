/* OmNote background PDF scanner/OCR worker.
   Keeps PDF extraction/OCR off the visible tab so it can continue while users
   switch tabs. Page content is untrusted; this worker only returns extracted text. */
(function () {
  'use strict';

  const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js';
  const PDFJS_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  // "fast" tessdata is 3-4x smaller and noticeably faster than "best"; still good.
  const TESSDATA_URL = 'https://tessdata.projectnaptha.com/4.0.0_fast';
  const OCR_STALL_TIMEOUT_MS = 45000;
  const OCR_HARD_TIMEOUT_MS = 180000;

  let loadedPdf = false;
  let loadedTesseract = false;

  function post(type, payload) {
    self.postMessage(Object.assign({ type }, payload || {}));
  }

  function ensurePdfJs() {
    if (loadedPdf && self.pdfjsLib) return;
    importScripts(PDFJS_URL);
    self.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    loadedPdf = true;
  }

  function ensureTesseract() {
    if (loadedTesseract && self.Tesseract) return;
    importScripts(TESSERACT_URL);
    loadedTesseract = true;
  }

  class OcrPageTimeout extends Error {
    constructor(message) {
      super(message);
      this.name = 'OcrPageTimeout';
    }
  }

  async function createTessWorker(ocrLang) {
    let tw = null;
    tw = await self.Tesseract.createWorker(ocrLang || 'eng', 1, {
      langPath: TESSDATA_URL,
      logger: (m) => {
        if (!m || m.status !== 'recognizing text' || typeof m.progress !== 'number') return;
        const fn = tw && tw.__omPageLogger;
        if (typeof fn === 'function') fn(m.progress);
      },
    });
    await tw.setParameters({ tessedit_pageseg_mode: '3' });
    tw.__omPageLogger = null;
    return tw;
  }

  function makeCanvas(width, height) {
    if (typeof OffscreenCanvas === 'undefined') {
      throw new Error('OffscreenCanvas is not available in this browser.');
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not create OCR canvas context.');
    return { canvas, ctx };
  }

  function binarizeInPlace(canvas, ctx) {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let p = 0; p < data.length; p += 4) {
      const avg = (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114);
      const color = avg > 150 ? 255 : 0;
      data[p] = color;
      data[p + 1] = color;
      data[p + 2] = color;
    }
    ctx.putImageData(imageData, 0, 0);
    return imageData;
  }

  async function extractTextForPage(pdf, pageNum) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const str = (textContent.items || []).map((it) => it.str || '').join(' ').trim();
    return str;
  }

  async function ocrOnePage(pdf, pageNum, tessWorker, scale, onPagePct) {
    if (typeof onPagePct === 'function') onPagePct(1);
    const page = await pdf.getPage(pageNum);
    if (typeof onPagePct === 'function') onPagePct(3);
    const viewport = page.getViewport({ scale });
    const { canvas, ctx } = makeCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: ctx, viewport }).promise;
    if (typeof onPagePct === 'function') onPagePct(7);
    binarizeInPlace(canvas, ctx);
    let input = canvas;
    if (typeof canvas.convertToBlob === 'function') {
      try { input = await canvas.convertToBlob({ type: 'image/png' }); } catch (_) { input = canvas; }
    }
    if (typeof onPagePct === 'function') onPagePct(12);
    // The Tesseract worker's logger (attached in createWorker) reads this
    // handler so we get sub-page progress for the current page.
    tessWorker.__omPageLogger = (progress01) => {
      const pct = Math.max(12, Math.min(99, Math.round(12 + progress01 * 87)));
      if (typeof onPagePct === 'function') onPagePct(pct);
    };
    try {
      const ret = await tessWorker.recognize(input);
      if (typeof onPagePct === 'function') onPagePct(100);
      return (ret && ret.data && ret.data.text) || '';
    } finally {
      tessWorker.__omPageLogger = null;
    }
  }

  function ocrOnePageWithWatchdog(pdf, pageNum, tessWorker, scale, onPagePct) {
    let lastProgressAt = Date.now();
    let lastPct = 0;
    const guardedProgress = (pct) => {
      lastProgressAt = Date.now();
      lastPct = Math.max(0, Math.min(100, Math.round(pct || 0)));
      if (typeof onPagePct === 'function') onPagePct(lastPct);
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearInterval(stallTimer);
        clearTimeout(hardTimer);
      };
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const stallTimer = setInterval(() => {
        if (Date.now() - lastProgressAt > OCR_STALL_TIMEOUT_MS) {
          finish(reject, new OcrPageTimeout(`OCR page ${pageNum} stalled at ${lastPct}%`));
        }
      }, 5000);
      const hardTimer = setTimeout(() => {
        finish(reject, new OcrPageTimeout(`OCR page ${pageNum} exceeded the safe time limit`));
      }, OCR_HARD_TIMEOUT_MS);

      ocrOnePage(pdf, pageNum, tessWorker, scale, guardedProgress)
        .then((text) => finish(resolve, text))
        .catch((err) => finish(reject, err));
    });
  }



  async function processPdf({ data, startPage, endPage, forceOCR, ocrLang, scale, concurrency }) {
    ensurePdfJs();
    const pdf = await self.pdfjsLib.getDocument({ data }).promise;
    const from = Math.max(1, startPage || 1);
    const to = Math.min(pdf.numPages, endPage || pdf.numPages);
    const total = Math.max(0, to - from + 1);
    const results = new Array(total).fill('');
    let doneCount = 0;
    post('progress', { mode: 'scan-start', page: from, done: 0, total, pagePct: 0 });

    // Pass 1: quick text extraction. Cheap, always runs first — pages with
    // real text skip OCR entirely, which is the biggest speed win.
    const needsOcrIdx = [];
    for (let pageNum = from; pageNum <= to; pageNum++) {
      const idx = pageNum - from;
      try {
        const t = forceOCR ? '' : await extractTextForPage(pdf, pageNum);
        if (!forceOCR && t && t.length > 20) {
          results[idx] = t;
          doneCount++;
          post('progress', { mode: 'text', page: pageNum, done: doneCount, total, pagePct: 100 });
        } else {
          needsOcrIdx.push(idx);
          post('progress', { mode: 'queued', page: pageNum, done: doneCount, total, pagePct: 0 });
        }
      } catch (_) {
        needsOcrIdx.push(idx);
      }
    }

    // Pass 2: OCR only what actually needs it, with a small worker pool.
    if (needsOcrIdx.length > 0) {
      ensureTesseract();
      const poolSize = Math.max(1, Math.min(concurrency || 2, needsOcrIdx.length));
      post('progress', { mode: 'ocr-init', done: doneCount, total, pagePct: 0, workers: poolSize });

      // Heartbeat so hidden tabs / long pages don't look stuck.
      const activePages = new Map(); // pageNum -> pagePct
      const heartbeat = setInterval(() => {
        const pages = Array.from(activePages.entries());
        post('progress', {
          mode: 'heartbeat',
          done: doneCount,
          total,
          activePages: pages.map(([page, pct]) => ({ page, pct })),
        });
      }, 1500);

      const workers = [];
      for (let w = 0; w < poolSize; w++) {
        workers.push(await createTessWorker(ocrLang || 'eng'));
      }


      let cursor = 0;
      const replaceWorker = async (oldWorker) => {
        try { await oldWorker.terminate(); } catch (_) {}
        const oldIndex = workers.indexOf(oldWorker);
        if (oldIndex >= 0) workers.splice(oldIndex, 1);
        const nextWorker = await createTessWorker(ocrLang || 'eng');
        workers.push(nextWorker);
        return nextWorker;
      };

      const runWorker = async (initialWorker) => {
        let tw = initialWorker;
        while (true) {
          const myIdx = cursor++;
          if (myIdx >= needsOcrIdx.length) return;
          const targetIdx = needsOcrIdx[myIdx];
          const pageNum = from + targetIdx;
          activePages.set(pageNum, 1);
          post('progress', { mode: 'ocr', page: pageNum, done: doneCount, total, pagePct: 1 });
          let pageText = '';
          try {
            for (let attempt = 0; attempt < 2; attempt++) {
              const attemptScale = attempt === 0 ? (scale || 2.0) : Math.max(1.15, Math.min(1.45, (scale || 2.0) * 0.7));
              try {
                if (attempt > 0) {
                  activePages.set(pageNum, 2);
                  post('progress', { mode: 'ocr-retry', page: pageNum, done: doneCount, total, pagePct: 2 });
                }
                pageText = await ocrOnePageWithWatchdog(pdf, pageNum, tw, attemptScale, (pct) => {
                  activePages.set(pageNum, pct);
                  post('progress', { mode: 'ocr-page', page: pageNum, done: doneCount, total, pagePct: pct });
                });
                break;
              } catch (err) {
                const timedOut = err && err.name === 'OcrPageTimeout';
                post('progress', {
                  mode: timedOut && attempt === 0 ? 'ocr-retry' : 'ocr-error',
                  page: pageNum,
                  done: doneCount,
                  total,
                  pagePct: Math.max(0, Math.min(99, activePages.get(pageNum) || 0)),
                });
                tw = await replaceWorker(tw);
                if (!timedOut || attempt >= 1) {
                  pageText = '';
                  break;
                }
              }
            }
            results[targetIdx] = pageText;
          } catch (err) {
            results[targetIdx] = '';
          }
          activePages.delete(pageNum);
          doneCount++;
          post('progress', { mode: 'ocr', page: pageNum, done: doneCount, total, pagePct: 100 });
        }
      };

      try {
        await Promise.all(workers.map(runWorker));
      } finally {
        clearInterval(heartbeat);
        await Promise.all(workers.map((tw) => tw.terminate().catch(() => {})));
      }
    }

    return results.join('\n');
  }

  self.onmessage = async (event) => {
    const job = event.data || {};
    try {
      post('ready');
      const text = await processPdf({
        data: job.data,
        startPage: job.startPage,
        endPage: job.endPage,
        forceOCR: !!job.needsOCR,
        ocrLang: job.ocrLang,
        scale: job.scale,
        concurrency: job.concurrency,
      });
      post('done', { text });
    } catch (error) {
      post('error', { message: error && error.message ? error.message : String(error) });
    }
  };
})();
