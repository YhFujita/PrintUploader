import React, { useState, useRef, useEffect, useCallback } from 'react';
import jsPDF from 'jspdf';
import ReactCrop from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';

// --- 【設定】GASのウェブアプリURLを貼り付けてください ---
const GAS_URL = 'https://script.google.com/macros/s/AKfycbzQgb7mJclr_yrvDCpVrjjv_V95uU6uLXGIUYpBfQxO7_gwexRr6iUy0IDs1DoduwPW/exec';

// ステータス定数
const STATUS = { PENDING: 'pending', UPLOADING: 'uploading', SUCCESS: 'success', FAILED: 'failed' };

// =============================================================
// 台形補正用のユーティリティ関数群
// =============================================================

// ガウスの消去法で 8x8 の連立方程式を解く
function gaussianElimination(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let max = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(M[row][col]) > Math.abs(M[max][col])) max = row;
    [M[col], M[max]] = [M[max], M[col]];
    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / M[col][col];
      for (let j = col; j <= n; j++) M[row][j] -= factor * M[col][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i][n] / M[i][i];
    for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j] / M[i][i];
  }
  return x;
}

// 4点から3x3ホモグラフィ行列を計算する
// srcPoints: 元画像の4点 [{x,y}], dstPoints: 変換先の4点 [{x,y}]
function computeHomography(srcPoints, dstPoints) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = [srcPoints[i].x, srcPoints[i].y];
    const [dx, dy] = [dstPoints[i].x, dstPoints[i].y];
    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
    b.push(dx); b.push(dy);
  }
  const h = gaussianElimination(A, b);
  return [...h, 1]; // h[0..7] + h[8]=1
}

// ホモグラフィ行列を使って逆マッピングで画像を台形補正する
function applyPerspectiveTransform(srcCanvas, corners) {
  // corners: 左上,右上,右下,左下 の4点（表示座標上）
  // まず出力サイズを決める（最も外側の矩形）
  const displayW = srcCanvas.width, displayH = srcCanvas.height;

  // 元画像4点（corners の座標は srcCanvas サイズに対応）
  const srcPts = corners; // [{x,y}] * 4

  // 出力先は正規化された矩形
  const W = Math.max(
    Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y),
    Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y)
  );
  const H = Math.max(
    Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y),
    Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y)
  );
  const outW = Math.round(W), outH = Math.round(H);

  const dstPts = [
    { x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }
  ];

  // 逆ホモグラフィ（dst -> src）を計算
  const H_inv = computeHomography(dstPts, srcPts);

  const srcCtx = srcCanvas.getContext('2d');
  const srcData = srcCtx.getImageData(0, 0, displayW, displayH);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW; outCanvas.height = outH;
  const outCtx = outCanvas.getContext('2d');
  const outData = outCtx.createImageData(outW, outH);

  const sw = srcData.width;

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const denom = H_inv[6] * x + H_inv[7] * y + H_inv[8];
      const srcX = (H_inv[0] * x + H_inv[1] * y + H_inv[2]) / denom;
      const srcY = (H_inv[3] * x + H_inv[4] * y + H_inv[5]) / denom;

      const sx = Math.round(srcX), sy = Math.round(srcY);
      const dstIdx = (y * outW + x) * 4;

      if (sx >= 0 && sx < displayW && sy >= 0 && sy < displayH) {
        const srcIdx = (sy * sw + sx) * 4;
        outData.data[dstIdx] = srcData.data[srcIdx];
        outData.data[dstIdx + 1] = srcData.data[srcIdx + 1];
        outData.data[dstIdx + 2] = srcData.data[srcIdx + 2];
        outData.data[dstIdx + 3] = 255;
      } else {
        outData.data[dstIdx + 3] = 0;
      }
    }
  }
  outCtx.putImageData(outData, 0, 0);
  return outCanvas;
}

// =============================================================
// 台形補正エディタ コンポーネント
// =============================================================
function PerspectiveEditor({ imageSrc, onConfirm, onCancel }) {
  const canvasRef = useRef(null);
  const [corners, setCorners] = useState(null); // [{x,y}] * 4: 左上,右上,右下,左下（表示canvas座標）
  const [draggingIdx, setDraggingIdx] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const imgRef = useRef(null);
  const containerRef = useRef(null);
  const HANDLE_RADIUS = 20;

  // 画像の読み込み＆Canvasへの描画
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const container = containerRef.current;
      const containerW = container.clientWidth || 375;
      const maxH = window.innerHeight * 0.55;
      const scale = Math.min(containerW / img.width, maxH / img.height, 1);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);

      // 初期コーナー: 全体の10%内側
      const ix = canvas.width * 0.05, iy = canvas.height * 0.05;
      setCorners([
        { x: ix, y: iy },
        { x: canvas.width - ix, y: iy },
        { x: canvas.width - ix, y: canvas.height - iy },
        { x: ix, y: canvas.height - iy }
      ]);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    };
    img.src = imageSrc;
  }, [imageSrc]);

  // コーナーが変わるたびにオーバーレイを再描画
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !corners || !imgRef.current) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imgRef.current, 0, 0, canvas.width, canvas.height);

    // 四角形の半透明オーバーレイ
    ctx.fillStyle = 'rgba(33,150,243,0.12)';
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    corners.forEach(c => ctx.lineTo(c.x, c.y));
    ctx.closePath(); ctx.fill();

    // 枠線（実線）
    ctx.strokeStyle = '#2196F3'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    corners.forEach(c => ctx.lineTo(c.x, c.y));
    ctx.closePath(); ctx.stroke();

    // ハンドル
    const labels = ['TL', 'TR', 'BR', 'BL'];
    corners.forEach((c, i) => {
      ctx.beginPath(); ctx.arc(c.x, c.y, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(33,150,243,0.85)'; ctx.fill();
      ctx.strokeStyle = 'white'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = 'white'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(labels[i], c.x, c.y);
    });
  }, [corners]);

  // タッチ/マウスイベントの共通処理
  const getPos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  };

  const findNearestCorner = (pos) => {
    let minDist = Infinity, idx = -1;
    corners.forEach((c, i) => {
      const d = Math.hypot(c.x - pos.x, c.y - pos.y);
      if (d < minDist) { minDist = d; idx = i; }
    });
    return minDist < HANDLE_RADIUS * 3 ? idx : -1;
  };

  const onStart = (e) => {
    e.preventDefault();
    const pos = getPos(e);
    const idx = findNearestCorner(pos);
    if (idx !== -1) setDraggingIdx(idx);
  };

  const onMove = (e) => {
    if (draggingIdx === null) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    const pos = getPos(e);
    const clamped = {
      x: Math.max(0, Math.min(canvas.width, pos.x)),
      y: Math.max(0, Math.min(canvas.height, pos.y))
    };
    setCorners(prev => prev.map((c, i) => i === draggingIdx ? clamped : c));
  };

  const onEnd = () => setDraggingIdx(null);

  // 台形補正を実行
  const handleConfirm = async () => {
    if (!corners || !imgRef.current) return;
    setIsProcessing(true);
    await new Promise(r => setTimeout(r, 50));

    const img = imgRef.current;
    const canvas = canvasRef.current;

    // 表示スケールを元の解像度に変換
    const scaleX = img.naturalWidth / canvas.width;
    const scaleY = img.naturalHeight / canvas.height;

    // 元解像度での台形補正（最大1600pxに縮小してから処理）
    const MAX_SIZE = 1600;
    const processScale = Math.min(MAX_SIZE / img.naturalWidth, MAX_SIZE / img.naturalHeight, 1);

    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = Math.round(img.naturalWidth * processScale);
    srcCanvas.height = Math.round(img.naturalHeight * processScale);
    const srcCtx = srcCanvas.getContext('2d');
    srcCtx.drawImage(img, 0, 0, srcCanvas.width, srcCanvas.height);

    // コーナー座標を処理スケールに変換
    const scaledCorners = corners.map(c => ({
      x: c.x * scaleX * processScale,
      y: c.y * scaleY * processScale
    }));

    // ホモグラフィ変換を実行
    const resultCanvas = applyPerspectiveTransform(srcCanvas, scaledCorners);
    const resultBase64 = resultCanvas.toDataURL('image/jpeg', 0.92);

    setIsProcessing(false);
    onConfirm(resultBase64);
  };

  return (
    <div ref={containerRef} style={{ userSelect: 'none', WebkitUserSelect: 'none' }}>
      <p style={{ fontWeight: 'bold', margin: '0 0 8px 0' }}>台形補正（4隅をドラッグ）</p>
      <p style={{ fontSize: '11px', color: '#666', margin: '0 0 10px 0' }}>青い丸を書類の四隅に合わせてください <br/>TL=左上 / TR=右上 / BR=右下 / BL=左下</p>
      <div style={{ border: '2px solid #2196F3', borderRadius: '8px', overflow: 'hidden', background: '#111', touchAction: 'none' }}>
        <canvas
          ref={canvasRef}
          style={{ display: 'block', maxWidth: '100%' }}
          onMouseDown={onStart} onMouseMove={onMove} onMouseUp={onEnd}
          onTouchStart={onStart} onTouchMove={onMove} onTouchEnd={onEnd}
        />
      </div>
      {isProcessing && (
        <div style={{ textAlign: 'center', padding: '15px', color: '#2196F3', fontWeight: 'bold' }}>
          ⏳ 台形補正を計算中...
        </div>
      )}
      <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
        <button onClick={onCancel} disabled={isProcessing} style={{ flex: 1, padding: '12px', background: '#ccc', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>
          キャンセル
        </button>
        <button onClick={handleConfirm} disabled={isProcessing} style={{ flex: 2, padding: '12px', background: '#9C27B0', color: 'white', fontWeight: 'bold', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>
          補正を適用 →
        </button>
      </div>
    </div>
  );
}

// =============================================================
// メインアプリ
// =============================================================
function App() {
  // 画面管理: 'capture' | 'perspective' | 'crop' | 'settings' | 'queue'
  const [currentView, setCurrentView] = useState('capture');

  // 撮影・編集用
  const [capturedImage, setCapturedImage] = useState(null);
  const [processedImage, setProcessedImage] = useState(null);
  const imgRef = useRef(null);
  const fileInputRef = useRef(null);
  const [crop, setCrop] = useState();
  const [completedCrop, setCompletedCrop] = useState(null);
  const [filterMode, setFilterMode] = useState('shadow');

  // 保存設定
  const [selectedCategory, setSelectedCategory] = useState('kids');
  const [comment, setComment] = useState('');
  const [customFolder, setCustomFolder] = useState('');
  const [existingFolders, setExistingFolders] = useState([]);
  const [isFetchingFolders, setIsFetchingFolders] = useState(false);

  // アップロードキュー
  const [uploadQueue, setUploadQueue] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const isUploadingRef = useRef(false);
  const [status, setStatus] = useState('');

  const getFiscalYear = () => {
    const d = new Date(); const y = d.getFullYear(); const m = d.getMonth() + 1;
    return (m >= 1 && m <= 3) ? `${y - 1}年度` : `${y}年度`;
  };

  // ===== 撮影 =====
  const handleCapture = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => { setCapturedImage(e.target.result); setCurrentView('perspective'); };
    reader.readAsDataURL(file);
    event.target.value = '';
  };

  // ===== 台形補正完了→クロップ画面へ =====
  const handlePerspectiveConfirm = (correctedBase64) => {
    setCapturedImage(correctedBase64);
    setCurrentView('crop');
  };

  // クロップ枠初期化
  const onImageLoad = (e) => {
    const { width, height } = e.currentTarget;
    setCrop({ unit: '%', x: 5, y: 5, width: 90, height: 90 });
    setCompletedCrop({ unit: 'px', x: Math.round(width * 0.05), y: Math.round(height * 0.05), width: Math.round(width * 0.9), height: Math.round(height * 0.9) });
  };

  // ===== スキャナフィルタ処理 =====
  const applyScannerFilter = (ctx, w, h, mode) => {
    if (mode === 'none') return;
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    if (mode === 'shadow') {
      const gray = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const idx = (y * w + x) * 4; gray[y * w + x] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]; }
      const integral = new Float64Array(w * h);
      for (let y = 0; y < h; y++) { let rs = 0; for (let x = 0; x < w; x++) { rs += gray[y * w + x]; integral[y * w + x] = rs + (y > 0 ? integral[(y - 1) * w + x] : 0); } }
      const bR = Math.max(Math.floor(Math.min(w, h) / 16), 15);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const x1 = Math.max(0, x - bR), y1 = Math.max(0, y - bR), x2 = Math.min(w - 1, x + bR), y2 = Math.min(h - 1, y + bR);
        const cnt = (x2 - x1 + 1) * (y2 - y1 + 1);
        let sum = integral[y2 * w + x2]; if (x1 > 0) sum -= integral[y2 * w + (x1 - 1)]; if (y1 > 0) sum -= integral[(y1 - 1) * w + x2]; if (x1 > 0 && y1 > 0) sum += integral[(y1 - 1) * w + (x1 - 1)];
        const lm = sum / cnt, pg = gray[y * w + x];
        let c = 255; if (pg < lm - 15) { c = Math.max(0, Math.min(255, 255 * (1 - ((lm - pg) / lm) * 2.5))); }
        const idx = (y * w + x) * 4; data[idx] = c; data[idx + 1] = c; data[idx + 2] = c;
      }
      ctx.putImageData(imageData, 0, 0); return;
    }

    const contrast = (mode === 'darkText') ? 120 : 100;
    const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    for (let i = 0; i < data.length; i += 4) {
      let g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (mode === 'darkText') g -= 40;
      let c = factor * (g - 128) + 128;
      if (mode === 'scanner') c += 30;
      c = Math.max(0, Math.min(255, c));
      data[i] = c; data[i + 1] = c; data[i + 2] = c;
    }
    ctx.putImageData(imageData, 0, 0);
  };

  // ===== トリミング＋フィルタ適用→設定画面へ =====
  const applyCropAndFilter = async () => {
    const image = imgRef.current;
    if (!image) return;
    const cc = completedCrop || { x: 0, y: 0, width: image.width, height: image.height, unit: 'px' };
    const canvas = document.createElement('canvas');
    const sx = image.naturalWidth / image.width, sy = image.naturalHeight / image.height;
    const tw = Math.floor(cc.width * sx), th = Math.floor(cc.height * sy);
    canvas.width = tw; canvas.height = th;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, cc.x * sx, cc.y * sy, tw, th, 0, 0, tw, th);
    applyScannerFilter(ctx, tw, th, filterMode);
    setProcessedImage(canvas.toDataURL('image/jpeg', 0.9));
    setCurrentView('settings');
    fetchExistingFolders(selectedCategory);
  };

  // ===== GASフォルダ取得 =====
  const fetchExistingFolders = async (category) => {
    if (!GAS_URL) return;
    setIsFetchingFolders(true);
    try {
      const res = await fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'getFolders', category, year: getFiscalYear() }) });
      const d = await res.json();
      if (d.success) setExistingFolders(d.folders || []);
    } catch { /* silent */ } finally { setIsFetchingFolders(false); }
  };

  const handleCategoryChange = (category) => {
    setSelectedCategory(category); setCustomFolder(''); setExistingFolders([]);
    fetchExistingFolders(category);
    setFilterMode('shadow');
  };

  // ===== キュー追加＆自動アップロード =====
  const addToQueue = () => {
    if (!processedImage) return;
    const thumbCanvas = document.createElement('canvas');
    const thumbImg = new Image();
    thumbImg.onload = () => {
      const mx = 150; let w = thumbImg.width, h = thumbImg.height;
      if (w > h) { if (w > mx) { h = Math.round(h * mx / w); w = mx; } } else { if (h > mx) { w = Math.round(w * mx / h); h = mx; } }
      thumbCanvas.width = w; thumbCanvas.height = h;
      thumbCanvas.getContext('2d').drawImage(thumbImg, 0, 0, w, h);
      const thumbnail = thumbCanvas.toDataURL('image/jpeg', 0.6);
      const newItem = { id: Date.now().toString() + Math.random().toString(36).substr(2, 5), thumbnail, processedImage, category: selectedCategory, customFolder, comment, filterMode, status: STATUS.PENDING, error: null };
      setUploadQueue(prev => {
        const newQ = [...prev, newItem];
        if (!isUploadingRef.current) setTimeout(() => processQueueWithItems(newQ), 0);
        return newQ;
      });
      setCapturedImage(null); setProcessedImage(null); setComment(''); setCurrentView('capture');
      setStatus('⚡ 追加＆アップロード開始！'); setTimeout(() => setStatus(''), 2000);
    };
    thumbImg.src = processedImage;
  };

  const removeFromQueue = (id) => setUploadQueue(prev => prev.filter(i => i.id !== id));

  // ===== 圧縮ユーティリティ =====
  const compressToJpeg = (src, maxSize, quality) => new Promise(resolve => {
    const img = new Image(); img.onload = () => {
      const c = document.createElement('canvas'); let w = img.width, h = img.height;
      if (w > h) { if (w > maxSize) { h = Math.round(h * maxSize / w); w = maxSize; } } else { if (h > maxSize) { w = Math.round(w * maxSize / h); h = maxSize; } }
      c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', quality));
    }; img.src = src;
  });

  const toPdfBase64 = (src) => new Promise(resolve => {
    const img = new Image(); img.onload = () => {
      const cc = document.createElement('canvas'); let w = img.width, h = img.height;
      const mx = 1600, q = 0.65;
      if (w > h) { if (w > mx) { h = Math.round(h * mx / w); w = mx; } } else { if (h > mx) { w = Math.round(w * mx / h); h = mx; } }
      cc.width = w; cc.height = h; cc.getContext('2d').drawImage(img, 0, 0, w, h);
      const compressed = cc.toDataURL('image/jpeg', q);
      const pi = new Image(); pi.onload = () => {
        const doc = new jsPDF(), pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight(), m = 10;
        let fw = pw - m * 2, fh = (pi.height * fw) / pi.width;
        if (fh > ph - m * 2) { fh = ph - m * 2; fw = (pi.width * fh) / pi.height; }
        doc.addImage(pi, 'JPEG', (pw - fw) / 2, m, fw, fh);
        resolve(doc.output('datauristring'));
      }; pi.src = compressed;
    }; img.src = src;
  });

  // ===== 単一アップロード =====
  const uploadSingleItem = async (item) => {
    let fileData, filename;
    const ts = new Date().toLocaleString('ja-JP').replace(/[\/\s:]/g, '');
    if (item.category === 'kids') {
      fileData = await compressToJpeg(item.processedImage, 1200, 0.85); filename = `子供写真_${ts}.jpg`;
    } else {
      fileData = await toPdfBase64(item.processedImage);
      const p = { receipt: '領収証', payslip: '給与明細', important: '重要書類' };
      filename = `${p[item.category] || '書類'}_${ts}.pdf`;
    }
    const res = await fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'save', category: item.category, fileData, filename, comment: item.comment, year: getFiscalYear(), customFolder: item.customFolder }) });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '保存に失敗');
  };

  // ===== キュー処理（items引数があればそれを使う） =====
  const processQueueWithItems = async (items) => {
    if (isUploadingRef.current) return;
    isUploadingRef.current = true; setIsUploading(true);
    const targets = (items || uploadQueue).filter(i => i.status === STATUS.PENDING || i.status === STATUS.FAILED);
    for (const item of targets) {
      setUploadQueue(prev => prev.map(i => i.id === item.id ? { ...i, status: STATUS.UPLOADING, error: null } : i));
      try { await uploadSingleItem(item); setUploadQueue(prev => prev.map(i => i.id === item.id ? { ...i, status: STATUS.SUCCESS, processedImage: null } : i)); }
      catch (e) { setUploadQueue(prev => prev.map(i => i.id === item.id ? { ...i, status: STATUS.FAILED, error: e.message } : i)); }
      await new Promise(r => setTimeout(r, 500));
    }
    isUploadingRef.current = false; setIsUploading(false);
  };
  const processQueue = () => processQueueWithItems(null);

  const clearCompleted = () => setUploadQueue(prev => prev.filter(i => i.status !== STATUS.SUCCESS));
  const retryFailed = () => setUploadQueue(prev => prev.map(i => i.status === STATUS.FAILED ? { ...i, status: STATUS.PENDING, error: null } : i));

  const queueCounts = {
    total: uploadQueue.length,
    pending: uploadQueue.filter(i => i.status === STATUS.PENDING).length,
    uploading: uploadQueue.filter(i => i.status === STATUS.UPLOADING).length,
    success: uploadQueue.filter(i => i.status === STATUS.SUCCESS).length,
    failed: uploadQueue.filter(i => i.status === STATUS.FAILED).length,
  };

  // ===== UIスタイル =====
  const btnStyle = (selected, color) => ({
    background: selected ? color : '#f0f0f0', color: selected ? 'white' : '#333',
    padding: '12px 10px', border: selected ? '1px solid ' + color : '1px solid #ddd',
    borderRadius: '8px', cursor: 'pointer', fontWeight: selected ? 'bold' : 'normal',
    transition: '0.2s', fontSize: '14px'
  });
  const statusIcon = (s) => s === STATUS.SUCCESS ? '✅' : s === STATUS.FAILED ? '❌' : s === STATUS.UPLOADING ? '⏳' : '🕐';
  const statusColor = (s) => s === STATUS.SUCCESS ? '#4CAF50' : s === STATUS.FAILED ? '#f44336' : s === STATUS.UPLOADING ? '#2196F3' : '#999';
  const categoryLabel = (c) => ({ kids: '🎨子供', receipt: '🧾領収', payslip: '💰給与', important: '🚨重要' }[c] || c);

  return (
    // iOS長押し選択・コンテキストメニューを全面的に抑制
    <div
      style={{ padding: '15px', textAlign: 'center', fontFamily: 'sans-serif', maxWidth: '500px', margin: '0 auto', userSelect: 'none', WebkitUserSelect: 'none' }}
      onContextMenu={e => e.preventDefault()}
    >
      <h2 style={{ marginBottom: '5px' }}>PrintUploader</h2>
      <p style={{ color: '#666', fontSize: '13px', marginTop: '0', marginBottom: '10px' }}>{getFiscalYear()} 保存受付中</p>

      {/* キューバッジ */}
      {uploadQueue.length > 0 && (
        <div onClick={() => setCurrentView('queue')} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: isUploading ? '#E3F2FD' : '#FFF3E0', padding: '8px 16px', borderRadius: '20px', border: `1px solid ${isUploading ? '#90CAF9' : '#FFE0B2'}`, cursor: 'pointer', marginBottom: '10px', fontSize: '14px' }}>
          <span>📋 キュー: {queueCounts.pending > 0 && `${queueCounts.pending}待ち `}{queueCounts.uploading > 0 && `${queueCounts.uploading}送信中 `}{queueCounts.success > 0 && `${queueCounts.success}完了 `}{queueCounts.failed > 0 && <span style={{ color: '#f44336' }}>{queueCounts.failed}失敗</span>}</span>
        </div>
      )}

      {/* ====== 撮影画面 ====== */}
      {currentView === 'capture' && (
        <div style={{ marginTop: '20px' }}>
          <input type="file" accept="image/*" capture="environment" ref={fileInputRef} onChange={handleCapture} style={{ display: 'none' }} />
          <button onClick={() => fileInputRef.current.click()} style={{ width: '100%', padding: '20px', fontSize: '18px', background: '#333', color: 'white', border: 'none', borderRadius: '12px', cursor: 'pointer', boxShadow: '0 4px 6px rgba(0,0,0,0.2)' }}>
            📸 写真を撮る / 選ぶ
          </button>
          {uploadQueue.length > 0 && (
            <button onClick={() => setCurrentView('queue')} style={{ width: '100%', marginTop: '15px', padding: '15px', fontSize: '16px', background: '#FF9800', color: 'white', border: 'none', borderRadius: '12px', cursor: 'pointer' }}>
              📋 キュー一覧 ({uploadQueue.length}枚)
            </button>
          )}
        </div>
      )}

      {/* ====== 台形補正画面 ====== */}
      {currentView === 'perspective' && capturedImage && (
        <div style={{ background: '#f9f9f9', padding: '15px', borderRadius: '12px', boxShadow: '0 2px 5px rgba(0,0,0,0.1)' }}>
          <PerspectiveEditor
            imageSrc={capturedImage}
            onConfirm={handlePerspectiveConfirm}
            onCancel={() => { setCapturedImage(null); setCurrentView('capture'); }}
          />
          <button
            onClick={() => setCurrentView('crop')}
            style={{ width: '100%', marginTop: '10px', padding: '10px', background: '#e0e0e0', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', color: '#555' }}
          >
            台形補正をスキップして切り抜きへ →
          </button>
        </div>
      )}

      {/* ====== トリミング・フィルタ画面 ====== */}
      {currentView === 'crop' && capturedImage && (
        <div style={{ background: '#f9f9f9', padding: '15px', borderRadius: '12px', boxShadow: '0 2px 5px rgba(0,0,0,0.1)' }}>
          <p style={{ fontWeight: 'bold', margin: '0 0 5px 0' }}>切り抜き・フィルタ</p>
          <div style={{ border: '1px solid #ddd', borderRadius: '8px', overflow: 'hidden', background: '#e0e0e0', marginBottom: '12px', touchAction: 'none' }}>
            <ReactCrop crop={crop} onChange={c => setCrop(c)} onComplete={c => setCompletedCrop(c)} keepSelection>
              <img ref={imgRef} src={capturedImage} alt="Crop" onLoad={onImageLoad} style={{ maxHeight: '45vh', display: 'block', margin: '0 auto', WebkitUserDrag: 'none' }} />
            </ReactCrop>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', marginBottom: '12px' }}>
            <button onClick={() => setFilterMode('none')} style={btnStyle(filterMode === 'none', '#9E9E9E')}>🖼 原本</button>
            <button onClick={() => setFilterMode('scanner')} style={btnStyle(filterMode === 'scanner', '#2196F3')}>📄 書類</button>
            <button onClick={() => setFilterMode('darkText')} style={btnStyle(filterMode === 'darkText', '#607D8B')}>✏️ 薄文字</button>
            <button onClick={() => setFilterMode('shadow')} style={btnStyle(filterMode === 'shadow', '#FF5722')}>📷 影補正</button>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => setCurrentView('perspective')} style={{ flex: 1, padding: '10px', background: '#9C27B0', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px' }}>↩ 台形補正</button>
            <button onClick={() => { setCapturedImage(null); setCurrentView('capture'); }} style={{ flex: 1, padding: '10px', background: '#ccc', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px' }}>やり直す</button>
            <button onClick={applyCropAndFilter} style={{ flex: 2, padding: '10px', background: '#4CAF50', color: 'white', fontWeight: 'bold', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>決定 →</button>
          </div>
        </div>
      )}

      {/* ====== 保存設定画面 ====== */}
      {currentView === 'settings' && processedImage && (
        <div style={{ background: '#f9f9f9', padding: '15px', borderRadius: '12px', boxShadow: '0 2px 5px rgba(0,0,0,0.1)', textAlign: 'left' }}>
          <div style={{ background: '#eee', padding: '5px', borderRadius: '8px', marginBottom: '15px', textAlign: 'center' }}>
            <img src={processedImage} alt="Preview" style={{ maxHeight: '120px', borderRadius: '4px', border: '1px solid #ccc' }} />
            <br /><button onClick={() => setCurrentView('crop')} style={{ marginTop: '5px', fontSize: '12px', padding: '4px 10px', background: '#ccc', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>✂ 再編集</button>
          </div>
          <p style={{ fontWeight: 'bold', margin: '0 0 8px 0', borderBottom: '2px solid #ddd', paddingBottom: '5px' }}>1. カテゴリ</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '15px' }}>
            <button onClick={() => handleCategoryChange('kids')} style={btnStyle(selectedCategory === 'kids', '#4CAF50')}>🎨 子供作品</button>
            <button onClick={() => handleCategoryChange('receipt')} style={btnStyle(selectedCategory === 'receipt', '#FF9800')}>🧾 領収証</button>
            <button onClick={() => handleCategoryChange('payslip')} style={btnStyle(selectedCategory === 'payslip', '#2196F3')}>💰 給与明細</button>
            <button onClick={() => handleCategoryChange('important')} style={btnStyle(selectedCategory === 'important', '#E91E63')}>🚨 重要書類</button>
          </div>
          <p style={{ fontWeight: 'bold', margin: '0 0 8px 0', borderBottom: '2px solid #ddd', paddingBottom: '5px' }}>2. フォルダ</p>
          <div style={{ background: 'white', padding: '10px', borderRadius: '8px', border: '1px solid #e0e0e0', marginBottom: '15px' }}>
            <p style={{ fontSize: '12px', color: '#666', margin: '0 0 5px 0' }}>※{getFiscalYear()}内。未入力で直下に保存。</p>
            <input type="text" value={customFolder} onChange={(e) => setCustomFolder(e.target.value)} placeholder="フォルダ名..." style={{ width: '100%', boxSizing: 'border-box', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', marginBottom: '8px' }} />
            {existingFolders.length > 0 && (
              <select onChange={(e) => setCustomFolder(e.target.value)} value={customFolder} style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', background: '#f9f9f9' }}>
                <option value="">▼ 既存フォルダ</option>
                {existingFolders.map((f, i) => <option key={i} value={f}>{f}</option>)}
              </select>
            )}
            {isFetchingFolders && <p style={{ fontSize: '12px', color: '#2196F3', margin: '5px 0 0' }}>検索中...</p>}
          </div>
          <p style={{ fontWeight: 'bold', margin: '0 0 8px 0', borderBottom: '2px solid #ddd', paddingBottom: '5px' }}>3. メモ</p>
          <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="内容メモ..." style={{ width: '100%', boxSizing: 'border-box', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', marginBottom: '15px' }} />
          <button onClick={addToQueue} style={{ width: '100%', padding: '16px', fontSize: '17px', background: '#FF9800', color: 'white', border: 'none', borderRadius: '12px', cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 4px 6px rgba(0,0,0,0.2)' }}>
            📋 キューに追加して次を撮影
          </button>
        </div>
      )}

      {/* ====== キュー一覧画面 ====== */}
      {currentView === 'queue' && (
        <div style={{ textAlign: 'left' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <p style={{ fontWeight: 'bold', fontSize: '16px', margin: 0 }}>アップロードキュー ({uploadQueue.length}枚)</p>
            <button onClick={() => setCurrentView('capture')} style={{ padding: '8px 12px', background: '#333', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px' }}>📸 撮影へ</button>
          </div>
          {isUploading && queueCounts.total > 0 && (
            <div style={{ background: '#e0e0e0', borderRadius: '4px', height: '8px', marginBottom: '15px', overflow: 'hidden' }}>
              <div style={{ background: '#4CAF50', height: '100%', width: `${(queueCounts.success / queueCounts.total) * 100}%`, transition: '0.3s' }} />
            </div>
          )}
          {uploadQueue.length === 0 && <p style={{ textAlign: 'center', color: '#888' }}>キューは空です。</p>}
          {uploadQueue.map((item) => (
            <div key={item.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '10px', background: 'white', borderRadius: '8px', marginBottom: '8px', border: `1px solid ${statusColor(item.status)}30` }}>
              <img src={item.thumbnail} alt="" style={{ width: '50px', height: '50px', objectFit: 'cover', borderRadius: '6px', border: '1px solid #ddd', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 'bold' }}>{categoryLabel(item.category)}{item.customFolder && ` / ${item.customFolder}`}</div>
                {item.comment && <div style={{ fontSize: '11px', color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.comment}</div>}
                {item.error && <div style={{ fontSize: '11px', color: '#f44336' }}>エラー: {item.error}</div>}
              </div>
              <div style={{ fontSize: '20px', flexShrink: 0 }}>{statusIcon(item.status)}</div>
              {(item.status === STATUS.PENDING || item.status === STATUS.FAILED) && (
                <button onClick={() => removeFromQueue(item.id)} style={{ padding: '4px 8px', background: '#f5f5f5', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>🗑</button>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '15px' }}>
            {(queueCounts.pending > 0 || queueCounts.failed > 0) && !isUploading && (
              <button onClick={processQueue} style={{ width: '100%', padding: '16px', fontSize: '17px', background: '#4CAF50', color: 'white', border: 'none', borderRadius: '12px', cursor: 'pointer', fontWeight: 'bold' }}>
                ☁ {queueCounts.pending + queueCounts.failed}枚をアップロード
              </button>
            )}
            {queueCounts.failed > 0 && !isUploading && (
              <button onClick={retryFailed} style={{ width: '100%', padding: '12px', background: '#FF5722', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>
                🔄 失敗した{queueCounts.failed}枚を再送
              </button>
            )}
            {queueCounts.success > 0 && (
              <button onClick={clearCompleted} style={{ width: '100%', padding: '12px', background: '#e0e0e0', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>
                🧹 完了済み({queueCounts.success}枚)を削除
              </button>
            )}
            {isUploading && <p style={{ textAlign: 'center', color: '#2196F3', fontWeight: 'bold' }}>⏳ バックグラウンドでアップロード中...</p>}
          </div>
        </div>
      )}

      {status && <p style={{ marginTop: '15px', color: '#333', fontWeight: 'bold', fontSize: '14px' }}>{status}</p>}
    </div>
  );
}

export default App;
