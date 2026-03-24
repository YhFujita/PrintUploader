import React, { useState, useRef, useEffect, useCallback } from 'react';
import jsPDF from 'jspdf';
import ReactCrop from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';

// --- 【設定】GASのウェブアプリURLを貼り付けてください ---
const GAS_URL = 'https://script.google.com/macros/s/AKfycbzQgb7mJclr_yrvDCpVrjjv_V95uU6uLXGIUYpBfQxO7_gwexRr6iUy0IDs1DoduwPW/exec';

// ステータス定数
const STATUS = { PENDING: 'pending', UPLOADING: 'uploading', SUCCESS: 'success', FAILED: 'failed' };

function App() {
  // ===== 画面管理 =====
  // 'capture' (撮影), 'crop' (トリミング), 'settings' (カテゴリ設定), 'queue' (キュー一覧)
  const [currentView, setCurrentView] = useState('capture');

  // ===== 撮影・編集用の一時ステート =====
  const [capturedImage, setCapturedImage] = useState(null);
  const [processedImage, setProcessedImage] = useState(null);
  const imgRef = useRef(null);
  const fileInputRef = useRef(null);
  const [crop, setCrop] = useState();
  const [completedCrop, setCompletedCrop] = useState(null);
  const [filterMode, setFilterMode] = useState('shadow'); // 影補正をデフォルトに

  // ===== 保存設定（次に追加するアイテム用） =====
  const [selectedCategory, setSelectedCategory] = useState('kids');
  const [comment, setComment] = useState('');
  const [customFolder, setCustomFolder] = useState('');
  const [existingFolders, setExistingFolders] = useState([]);
  const [isFetchingFolders, setIsFetchingFolders] = useState(false);

  // ===== アップロードキュー =====
  const [uploadQueue, setUploadQueue] = useState([]); // { id, thumbnail, processedImage, category, customFolder, comment, status, error }
  const [isUploading, setIsUploading] = useState(false);
  const isUploadingRef = useRef(false); // useEffect内で最新の状態を参照するためのRef

  const [status, setStatus] = useState('');

  // 年度計算 (日本式: 4月始まり)
  const getFiscalYear = () => {
    const d = new Date();
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    return (m >= 1 && m <= 3) ? `${y - 1}年度` : `${y}年度`;
  };

  // ===== ステップ1: カメラで撮影 =====
  const handleCapture = (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setCapturedImage(e.target.result);
      setCurrentView('crop');
    };
    reader.readAsDataURL(file);
    // inputをリセットして同じファイルを再選択可能にする
    event.target.value = '';
  };

  // クロップ枠の初期化
  const onImageLoad = (e) => {
    const { width, height } = e.currentTarget;
    const initialCrop = { unit: '%', x: 5, y: 5, width: 90, height: 90 };
    setCrop(initialCrop);
    setCompletedCrop({
      unit: 'px',
      x: Math.round(width * 0.05), y: Math.round(height * 0.05),
      width: Math.round(width * 0.9), height: Math.round(height * 0.9)
    });
  };

  // ===== フィルタ処理 =====
  const applyScannerFilter = (ctx, w, h, mode) => {
    if (mode === 'none') return;
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    if (mode === 'shadow') {
      const gray = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        gray[y * w + x] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      }
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

  // ===== トリミング・フィルタの実行 =====
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

    const base64 = canvas.toDataURL('image/jpeg', 0.9);
    setProcessedImage(base64);
    setCurrentView('settings');
    fetchExistingFolders(selectedCategory);
  };

  // ===== GASフォルダ一覧取得 =====
  const fetchExistingFolders = async (category) => {
    if (!GAS_URL) return;
    setIsFetchingFolders(true);
    try {
      const res = await fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'getFolders', category, year: getFiscalYear() }) });
      const d = await res.json();
      if (d.success) setExistingFolders(d.folders || []);
    } catch (e) { /* エラー時は空のまま */ }
    finally { setIsFetchingFolders(false); }
  };

  const handleCategoryChange = (category) => {
    setSelectedCategory(category);
    setCustomFolder('');
    setExistingFolders([]);
    fetchExistingFolders(category);
    if (category !== 'kids') setFilterMode('shadow'); else setFilterMode('shadow');
  };

  // ===== キューに画像を追加（追加後すぐにアップロード開始） =====
  const addToQueue = () => {
    if (!processedImage) return;
    // サムネイルは小さく作る（メモリ節約のため）
    const thumbCanvas = document.createElement('canvas');
    const thumbImg = new Image();
    thumbImg.onload = () => {
      const maxThumb = 150;
      let w = thumbImg.width, h = thumbImg.height;
      if (w > h) { if (w > maxThumb) { h = Math.round(h * (maxThumb / w)); w = maxThumb; } }
      else { if (h > maxThumb) { w = Math.round(w * (maxThumb / h)); h = maxThumb; } }
      thumbCanvas.width = w; thumbCanvas.height = h;
      thumbCanvas.getContext('2d').drawImage(thumbImg, 0, 0, w, h);
      const thumbnail = thumbCanvas.toDataURL('image/jpeg', 0.6);

      const newItem = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
        thumbnail,
        processedImage,
        category: selectedCategory,
        customFolder,
        comment,
        filterMode,
        status: STATUS.PENDING,
        error: null
      };

      // 新アイテムを含む最新のキューを取得して直接アップロードトリガーへ渡す
      setUploadQueue(prev => {
        const newQueue = [...prev, newItem];
        // アップロード中でなければ即座に開始する
        if (!isUploadingRef.current) {
          // setStateは非同期なので、最新のキューをそのまま渡して処理する
          setTimeout(() => processQueueWithItems(newQueue), 0);
        }
        return newQueue;
      });

      // リセットして次の撮影へ
      setCapturedImage(null);
      setProcessedImage(null);
      setComment('');
      setCurrentView('capture');
      setStatus('⚡ 追加＆アップロード開始！');
      setTimeout(() => setStatus(''), 2000);
    };
    thumbImg.src = processedImage;
  };

  // ===== キューから個別削除 =====
  const removeFromQueue = (id) => {
    setUploadQueue(prev => prev.filter(item => item.id !== id));
  };

  // ===== 画像圧縮ユーティリティ =====
  const compressToJpeg = (imageSrc, maxSize, quality) => new Promise((resolve) => {
    const img = new Image(); img.onload = () => {
      const c = document.createElement('canvas'); let w = img.width, h = img.height;
      if (w > h) { if (w > maxSize) { h = Math.round(h * (maxSize / w)); w = maxSize; } }
      else { if (h > maxSize) { w = Math.round(w * (maxSize / h)); h = maxSize; } }
      c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', quality));
    }; img.src = imageSrc;
  });

  const toPdfBase64 = (imageSrc) => new Promise((resolve) => {
    const img = new Image(); img.onload = () => {
      const cc = document.createElement('canvas'); let w = img.width, h = img.height;
      const mx = 1600; const q = 0.65;
      if (w > h) { if (w > mx) { h = Math.round(h * (mx / w)); w = mx; } } else { if (h > mx) { w = Math.round(w * (mx / h)); h = mx; } }
      cc.width = w; cc.height = h; cc.getContext('2d').drawImage(img, 0, 0, w, h);
      const compressed = cc.toDataURL('image/jpeg', q);
      const pi = new Image(); pi.onload = () => {
        const doc = new jsPDF(); const pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight(), m = 10;
        let fw = pw - m * 2, fh = (pi.height * fw) / pi.width;
        if (fh > ph - m * 2) { fh = ph - m * 2; fw = (pi.width * fh) / pi.height; }
        doc.addImage(pi, 'JPEG', (pw - fw) / 2, m, fw, fh);
        resolve(doc.output('datauristring'));
      }; pi.src = compressed;
    }; img.src = imageSrc;
  });

  // ===== 単一アイテムのアップロード処理 =====
  const uploadSingleItem = async (item) => {
    let fileData, filename;
    const ts = new Date().toLocaleString('ja-JP').replace(/[\/\s:]/g, '');

    if (item.category === 'kids') {
      fileData = await compressToJpeg(item.processedImage, 1200, 0.85);
      filename = `子供写真_${ts}.jpg`;
    } else {
      fileData = await toPdfBase64(item.processedImage);
      const prefixes = { receipt: '領収証', payslip: '給与明細', important: '重要書類' };
      filename = `${prefixes[item.category] || '書類'}_${ts}.pdf`;
    }

    const res = await fetch(GAS_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'save', category: item.category, fileData, filename, comment: item.comment, year: getFiscalYear(), customFolder: item.customFolder })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || '保存に失敗しました');
    return data;
  };


  // ===== キュー内のpending/failedアイテムを順次アップロード =====
  // items: 処理対象のキュー配列。指定なしの場合はstateのuploadQueueを使う
  const processQueueWithItems = async (items) => {
    if (isUploadingRef.current) return;
    isUploadingRef.current = true;
    setIsUploading(true);

    const itemsToUpload = (items || uploadQueue).filter(i => i.status === STATUS.PENDING || i.status === STATUS.FAILED);

    for (const item of itemsToUpload) {
      setUploadQueue(prev => prev.map(i => i.id === item.id ? { ...i, status: STATUS.UPLOADING, error: null } : i));
      
      try {
        await uploadSingleItem(item);
        setUploadQueue(prev => prev.map(i => i.id === item.id ? { ...i, status: STATUS.SUCCESS, processedImage: null } : i));
      } catch (error) {
        setUploadQueue(prev => prev.map(i => i.id === item.id ? { ...i, status: STATUS.FAILED, error: error.message } : i));
      }

      // GASへの負荷を分散
      await new Promise(r => setTimeout(r, 500));
    }

    isUploadingRef.current = false;
    setIsUploading(false);
  };

  // キュー画面の「アップロード開始」ボタン用（引数なしで現在のstateを使う）
  const processQueue = () => processQueueWithItems(null);



  // ===== 完了済みアイテムを一括削除 =====
  const clearCompleted = () => {
    setUploadQueue(prev => prev.filter(i => i.status !== STATUS.SUCCESS));
  };

  // ===== 失敗した画像だけ再アップロード =====
  const retryFailed = () => {
    setUploadQueue(prev => prev.map(i => i.status === STATUS.FAILED ? { ...i, status: STATUS.PENDING, error: null } : i));
  };

  // キュー状態の集計
  const queueCounts = {
    total: uploadQueue.length,
    pending: uploadQueue.filter(i => i.status === STATUS.PENDING).length,
    uploading: uploadQueue.filter(i => i.status === STATUS.UPLOADING).length,
    success: uploadQueue.filter(i => i.status === STATUS.SUCCESS).length,
    failed: uploadQueue.filter(i => i.status === STATUS.FAILED).length,
  };

  // ===== UI =====
  const btnStyle = (selected, color) => ({
    background: selected ? color : '#f0f0f0', color: selected ? 'white' : '#333',
    padding: '12px 10px', border: selected ? '1px solid ' + color : '1px solid #ddd',
    borderRadius: '8px', cursor: 'pointer', fontWeight: selected ? 'bold' : 'normal',
    transition: '0.2s', fontSize: '14px'
  });

  const statusColor = (s) => {
    if (s === STATUS.SUCCESS) return '#4CAF50';
    if (s === STATUS.FAILED) return '#f44336';
    if (s === STATUS.UPLOADING) return '#2196F3';
    return '#999';
  };
  const statusIcon = (s) => {
    if (s === STATUS.SUCCESS) return '✅';
    if (s === STATUS.FAILED) return '❌';
    if (s === STATUS.UPLOADING) return '⏳';
    return '🕐';
  };

  const categoryLabel = (c) => {
    if (c === 'kids') return '🎨子供'; if (c === 'receipt') return '🧾領収';
    if (c === 'payslip') return '💰給与'; if (c === 'important') return '🚨重要';
    return c;
  };

  return (
    <div style={{ padding: '15px', textAlign: 'center', fontFamily: 'sans-serif', maxWidth: '500px', margin: '0 auto' }}>
      <h2 style={{ marginBottom: '5px' }}>PrintUploader</h2>
      <p style={{ color: '#666', fontSize: '13px', marginTop: '0', marginBottom: '10px' }}>{getFiscalYear()} 保存受付中</p>

      {/* ====== キューバッジ（常時表示） ====== */}
      {uploadQueue.length > 0 && (
        <div
          onClick={() => setCurrentView('queue')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', background: isUploading ? '#E3F2FD' : '#FFF3E0', padding: '8px 16px', borderRadius: '20px', border: `1px solid ${isUploading ? '#90CAF9' : '#FFE0B2'}`, cursor: 'pointer', marginBottom: '10px', fontSize: '14px' }}
        >
          {isUploading && <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span>}
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
              📋 キュー一覧を見る ({uploadQueue.length}枚)
            </button>
          )}
        </div>
      )}

      {/* ====== トリミング画面 ====== */}
      {currentView === 'crop' && capturedImage && (
        <div style={{ background: '#f9f9f9', padding: '15px', borderRadius: '12px', boxShadow: '0 2px 5px rgba(0,0,0,0.1)' }}>
          <p style={{ fontWeight: 'bold', margin: '0 0 10px 0' }}>画像のトリミング・調整</p>
          <div style={{ border: '1px solid #ddd', borderRadius: '8px', overflow: 'hidden', background: '#e0e0e0', marginBottom: '15px' }}>
            <ReactCrop crop={crop} onChange={c => setCrop(c)} onComplete={c => setCompletedCrop(c)} keepSelection>
              <img ref={imgRef} src={capturedImage} alt="Crop" onLoad={onImageLoad} style={{ maxHeight: '50vh', display: 'block', margin: '0 auto' }} />
            </ReactCrop>
          </div>
          <p style={{ fontWeight: 'bold', fontSize: '14px', margin: '0 0 8px 0', textAlign: 'left' }}>画像モード</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', marginBottom: '20px' }}>
            <button onClick={() => setFilterMode('none')} style={btnStyle(filterMode === 'none', '#9E9E9E')}>🖼 原本</button>
            <button onClick={() => setFilterMode('scanner')} style={btnStyle(filterMode === 'scanner', '#2196F3')}>📄 書類</button>
            <button onClick={() => setFilterMode('darkText')} style={btnStyle(filterMode === 'darkText', '#607D8B')}>✏️ 薄文字</button>
            <button onClick={() => setFilterMode('shadow')} style={btnStyle(filterMode === 'shadow', '#FF5722')}>📷 影補正</button>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={() => { setCapturedImage(null); setCurrentView('capture'); }} style={{ flex: 1, padding: '12px', background: '#ccc', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>やり直す</button>
            <button onClick={applyCropAndFilter} style={{ flex: 2, padding: '12px', background: '#4CAF50', color: 'white', fontWeight: 'bold', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>決定 →</button>
          </div>
        </div>
      )}

      {/* ====== カテゴリ・保存設定画面 ====== */}
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
                {existingFolders.map((f, i) => (<option key={i} value={f}>{f}</option>))}
              </select>
            )}
            {isFetchingFolders && <p style={{ fontSize: '12px', color: '#2196F3', margin: '5px 0 0' }}>検索中...</p>}
          </div>

          <p style={{ fontWeight: 'bold', margin: '0 0 8px 0', borderBottom: '2px solid #ddd', paddingBottom: '5px' }}>3. メモ</p>
          <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="内容メモ..." style={{ width: '100%', boxSizing: 'border-box', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', marginBottom: '15px' }} />

          <button onClick={addToQueue} style={{ width: '100%', padding: '16px', fontSize: '17px', background: '#FF9800', color: 'white', border: 'none', borderRadius: '12px', cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 4px 6px rgba(0,0,0,0.2)', marginBottom: '10px' }}>
            📋 キューに追加して次を撮影
          </button>
        </div>
      )}

      {/* ====== キュー一覧画面 ====== */}
      {currentView === 'queue' && (
        <div style={{ textAlign: 'left' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <p style={{ fontWeight: 'bold', fontSize: '16px', margin: 0 }}>アップロードキュー ({uploadQueue.length}枚)</p>
            <button onClick={() => setCurrentView('capture')} style={{ padding: '8px 12px', background: '#333', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px' }}>📸 撮影に戻る</button>
          </div>

          {/* プログレスバー (アップロード中のみ) */}
          {isUploading && queueCounts.total > 0 && (
            <div style={{ background: '#e0e0e0', borderRadius: '4px', height: '8px', marginBottom: '15px', overflow: 'hidden' }}>
              <div style={{ background: '#4CAF50', height: '100%', width: `${(queueCounts.success / queueCounts.total) * 100}%`, transition: '0.3s' }} />
            </div>
          )}

          {/* アイテム一覧 */}
          {uploadQueue.length === 0 && <p style={{ textAlign: 'center', color: '#888' }}>キューは空です。撮影してください。</p>}
          {uploadQueue.map((item) => (
            <div key={item.id} style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '10px', background: 'white', borderRadius: '8px', marginBottom: '8px', border: `1px solid ${statusColor(item.status)}30`, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <img src={item.thumbnail} alt="" style={{ width: '50px', height: '50px', objectFit: 'cover', borderRadius: '6px', border: '1px solid #ddd', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 'bold' }}>{categoryLabel(item.category)}{item.customFolder && ` / ${item.customFolder}`}</div>
                {item.comment && <div style={{ fontSize: '11px', color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.comment}</div>}
                {item.error && <div style={{ fontSize: '11px', color: '#f44336' }}>エラー: {item.error}</div>}
              </div>
              <div style={{ fontSize: '20px', flexShrink: 0 }}>{statusIcon(item.status)}</div>
              {(item.status === STATUS.PENDING || item.status === STATUS.FAILED) && (
                <button onClick={() => removeFromQueue(item.id)} style={{ padding: '4px 8px', background: '#f5f5f5', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', flexShrink: 0 }}>🗑</button>
              )}
            </div>
          ))}

          {/* アクションボタン */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '15px' }}>
            {(queueCounts.pending > 0 || queueCounts.failed > 0) && !isUploading && (
              <button onClick={processQueue} style={{ width: '100%', padding: '16px', fontSize: '17px', background: '#4CAF50', color: 'white', border: 'none', borderRadius: '12px', cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 4px 6px rgba(0,0,0,0.2)' }}>
                ☁ {queueCounts.pending + queueCounts.failed}枚をアップロード開始
              </button>
            )}
            {queueCounts.failed > 0 && !isUploading && (
              <button onClick={retryFailed} style={{ width: '100%', padding: '12px', background: '#FF5722', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>
                🔄 失敗した{queueCounts.failed}枚を再アップロード
              </button>
            )}
            {queueCounts.success > 0 && (
              <button onClick={clearCompleted} style={{ width: '100%', padding: '12px', background: '#e0e0e0', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>
                🧹 完了済み({queueCounts.success}枚)をリストから削除
              </button>
            )}
            {isUploading && (
              <p style={{ textAlign: 'center', color: '#2196F3', fontWeight: 'bold' }}>⏳ アップロード処理中... 撮影に戻っても大丈夫です</p>
            )}
          </div>
        </div>
      )}

      {status && <p style={{ marginTop: '15px', color: '#333', fontWeight: 'bold', fontSize: '14px' }}>{status}</p>}
    </div>
  );
}

export default App;
