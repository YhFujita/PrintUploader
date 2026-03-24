import React, { useState, useRef, useEffect } from 'react';
import jsPDF from 'jspdf';
import ReactCrop, { centerCrop, makeAspectCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css'; // クロップ機能のCSS

// --- 【設定】GASのウェブアプリURLを貼り付けてください ---
const GAS_URL = 'https://script.google.com/macros/s/AKfycbzQgb7mJclr_yrvDCpVrjjv_V95uU6uLXGIUYpBfQxO7_gwexRr6iUy0IDs1DoduwPW/exec';

function App() {
  // アプリケーションのステップ管理 (1: 撮影, 2: 編集(クロップ), 3: 保存)
  const [step, setStep] = useState(1);

  // 画像関連のステート
  const [capturedImage, setCapturedImage] = useState(null); // オリジナル写真
  const [processedImage, setProcessedImage] = useState(null); // 編集後の高画質写真
  
  // クロップ(トリミング)用のステート
  const imgRef = useRef(null);
  const fileInputRef = useRef(null);
  const [crop, setCrop] = useState();
  const [completedCrop, setCompletedCrop] = useState(null);
  
  // フィルタ状態 ('none': そのまま, 'scanner': 白黒クッキリ, 'darkText': 薄い文字強調)
  const [filterMode, setFilterMode] = useState('scanner');

  // 保存設定関連のステート
  const [selectedCategory, setSelectedCategory] = useState('kids');
  const [comment, setComment] = useState('');
  const [customFolder, setCustomFolder] = useState('');
  
  // GAS関連ステート
  const [existingFolders, setExistingFolders] = useState([]);
  const [isFetchingFolders, setIsFetchingFolders] = useState(false);
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // いまの年度を計算 (日本式: 4月始まり)
  const getFiscalYear = () => {
    const d = new Date();
    const currentYear = d.getFullYear();
    const currentMonth = d.getMonth() + 1; // 1~12
    if (currentMonth >= 1 && currentMonth <= 3) return `${currentYear - 1}年度`;
    return `${currentYear}年度`;
  };

  // --- ステップ1: カメラで撮影 ---
  const handleCapture = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setStatus('読み込み中...');
    const reader = new FileReader();
    reader.onload = (e) => {
      setCapturedImage(e.target.result);
      setStep(2); // 編集ステップへ
      setStatus('');
    };
    reader.readAsDataURL(file);
  };

  // クロップ枠の初期化（画像が読み込まれた時）
  const onImageLoad = (e) => {
    const { width, height } = e.currentTarget;
    const initialCrop = centerCrop(
      makeAspectCrop({ unit: '%', width: 90, height: 90 }, width / height, width, height),
      width,
      height
    );
    setCrop(initialCrop);
  };

  // --- ピクセル操作によるスキャナ(白黒)フィルタ ---
  const applyScannerFilter = (ctx, canvasWidth, canvasHeight, mode) => {
    if (mode === 'none') return; // そのまま

    const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
    const data = imageData.data;

    // --- 影補正モード: 適応的二値化（ブロックごとに局所平均を計算して背景を均一化） ---
    if (mode === 'shadow') {
      // 1. まずグレースケール配列を作成
      const w = canvasWidth;
      const h = canvasHeight;
      const gray = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = (y * w + x) * 4;
          gray[y * w + x] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
        }
      }

      // 2. 積分画像 (Integral Image) を構築して、任意のブロックの平均を高速に計算する
      const integral = new Float64Array(w * h);
      for (let y = 0; y < h; y++) {
        let rowSum = 0;
        for (let x = 0; x < w; x++) {
          rowSum += gray[y * w + x];
          integral[y * w + x] = rowSum + (y > 0 ? integral[(y - 1) * w + x] : 0);
        }
      }

      // ブロックの半径（大きいほど広い範囲の影に対応できるが処理が遅くなる）
      const blockRadius = Math.max(Math.floor(Math.min(w, h) / 16), 15);
      // しきい値オフセット（局所平均からこの値だけ暗いピクセルを「文字」とみなす）
      const threshOffset = 15;

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          // ブロック範囲（画像端をクランプ）
          const x1 = Math.max(0, x - blockRadius);
          const y1 = Math.max(0, y - blockRadius);
          const x2 = Math.min(w - 1, x + blockRadius);
          const y2 = Math.min(h - 1, y + blockRadius);
          const count = (x2 - x1 + 1) * (y2 - y1 + 1);

          // 積分画像を使ってブロック内の合計を O(1) で取得
          let sum = integral[y2 * w + x2];
          if (x1 > 0) sum -= integral[y2 * w + (x1 - 1)];
          if (y1 > 0) sum -= integral[(y1 - 1) * w + x2];
          if (x1 > 0 && y1 > 0) sum += integral[(y1 - 1) * w + (x1 - 1)];

          const localMean = sum / count;
          const pixelGray = gray[y * w + x];
          
          // 局所平均より暗い → 文字部分（黒で強調）、そうでなければ背景（白）
          // ソフト版で、完全に0か255にせず、中間の黒さも残す
          let color;
          if (pixelGray < localMean - threshOffset) {
            // 文字部分のトーンを保持しつつ黒くする
            const ratio = (localMean - pixelGray) / localMean;
            color = Math.max(0, Math.min(255, 255 * (1 - ratio * 2.5)));
          } else {
            // 背景を白に飛ばす
            color = 255;
          }

          const idx = (y * w + x) * 4;
          data[idx] = color;
          data[idx + 1] = color;
          data[idx + 2] = color;
        }
      }

      ctx.putImageData(imageData, 0, 0);
      return;
    }

    // --- 通常モード (scanner / darkText) ---
    const contrast = (mode === 'darkText') ? 120 : 100; 
    const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));

    for (let i = 0; i < data.length; i += 4) {
      let gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      
      if (mode === 'darkText') {
        gray -= 40; 
      }

      let color = factor * (gray - 128) + 128;
      
      if (mode === 'scanner') {
        color += 30;
      }
      
      color = Math.max(0, Math.min(255, color));

      data[i] = color;
      data[i + 1] = color;
      data[i + 2] = color;
    }
    ctx.putImageData(imageData, 0, 0);
  };

  // --- ステップ2: トリミング・フィルタの実行 ---
  const applyCropAndFilter = async () => {
    const image = imgRef.current;
    if (!image || !completedCrop?.width || !completedCrop?.height) {
      // クロップ操作を一切せずに進もうとした場合、全体を対象にする
      if (image) {
        setCompletedCrop({
          x: 0, y: 0, width: image.width, height: image.height, unit: 'px'
        });
      } else {
        return;
      }
    }

    const canvas = document.createElement('canvas');
    const scaleX = image.naturalWidth / image.width;
    const scaleY = image.naturalHeight / image.height;
    
    // クロップされた実際のリアルピクセルサイズ
    const targetWidth = Math.floor((completedCrop?.width || image.width) * scaleX);
    const targetHeight = Math.floor((completedCrop?.height || image.height) * scaleY);

    // **この段階では解像度を落とさず、クロップと白黒化のみを原寸で行う**
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');

    // クロップ対象を描画
    ctx.drawImage(
      image,
      (completedCrop?.x || 0) * scaleX,
      (completedCrop?.y || 0) * scaleY,
      targetWidth,
      targetHeight,
      0,
      0,
      targetWidth,
      targetHeight
    );

    // 選択されたフィルタモード（書類、薄い文字など）をかける
    applyScannerFilter(ctx, targetWidth, targetHeight, filterMode);

    // プレビュー用に一時保持する（0.9画質で少し容量を抑えつつキレイに保つ）
    const base64Image = canvas.toDataURL('image/jpeg', 0.9);
    setProcessedImage(base64Image);
    
    // ステップ3に進み、初期カテゴリのフォルダ一覧を取得しておく
    setStep(3);
    fetchExistingFolders(selectedCategory);
    setStatus('カテゴリと保存先を選んでアップロードします。');
  };

  // --- GASへ既存サブフォルダ一覧を取得しにいく ---
  const fetchExistingFolders = async (category) => {
    if (GAS_URL === 'ここにGASのデプロイURLを貼り付けてください' || !GAS_URL) return;
    setIsFetchingFolders(true);
    setStatus('作成済みのフォルダを検索中...');
    try {
      const response = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'getFolders', category: category, year: getFiscalYear() })
      });
      const data = await response.json();
      if (data.success) {
        setExistingFolders(data.folders || []);
        setStatus('準備完了。保存先を設定してください。');
      } else {
        setStatus(`⚠ フォルダリストの取得に失敗: ${data.error}`);
      }
    } catch (error) {
      setStatus(`⚠ ネットワークエラー`);
    } finally {
      setIsFetchingFolders(false);
    }
  };

  const handleCategoryChange = (category) => {
    setSelectedCategory(category);
    setCustomFolder(''); 
    setExistingFolders([]);
    fetchExistingFolders(category);
    
    // カテゴリが子供写真以外の場合、スキャナモードを自動的にONにする（おすすめ）
    if (category !== 'kids') {
      setFilterMode('scanner');
    } else {
      setFilterMode('none');
    }
  };

  // --- JPG保存時にのみ画像を圧縮・リサイズするロジック ---
  const compressToJpegBase64 = async (imageSrc, maxSize = 1200, quality = 0.85) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        if (width > height) {
          if (width > maxSize) { height = Math.round(height * (maxSize / width)); width = maxSize; }
        } else {
          if (height > maxSize) { width = Math.round(width * (maxSize / height)); height = maxSize; }
        }
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = imageSrc;
    });
  };

  // --- PDFとしてBase64化するロジック (適度にリサイズして容量を削減) ---
  const getPdfBase64 = async (imageSrc) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        // まず画像を適度なサイズに縮小してJPEG圧縮する（PDF容量削減の核心部分）
        const compressCanvas = document.createElement('canvas');
        const PDF_MAX_SIZE = 1600; // 長辺1600pxあればA4印刷でも十分きれい
        const PDF_QUALITY = 0.65;  // JPEG品質65%（白黒文書なら劣化はほぼ目立たない）
        let cw = img.width;
        let ch = img.height;
        if (cw > ch) {
          if (cw > PDF_MAX_SIZE) { ch = Math.round(ch * (PDF_MAX_SIZE / cw)); cw = PDF_MAX_SIZE; }
        } else {
          if (ch > PDF_MAX_SIZE) { cw = Math.round(cw * (PDF_MAX_SIZE / ch)); ch = PDF_MAX_SIZE; }
        }
        compressCanvas.width = cw;
        compressCanvas.height = ch;
        const cctx = compressCanvas.getContext('2d');
        cctx.drawImage(img, 0, 0, cw, ch);
        // 圧縮済みの画像をData URL化
        const compressedSrc = compressCanvas.toDataURL('image/jpeg', PDF_QUALITY);

        // 圧縮済み画像をPDFのA4枠に貼り付ける
        const pdfImg = new Image();
        pdfImg.onload = () => {
          const doc = new jsPDF();
          const pageWidth = doc.internal.pageSize.getWidth();
          const pageHeight = doc.internal.pageSize.getHeight();
          const margin = 10;
          const targetWidth = pageWidth - (margin * 2);

          let imgWidth = pdfImg.width; let imgHeight = pdfImg.height;
          let finalWidth = targetWidth; let finalHeight = (imgHeight * finalWidth) / imgWidth;

          if (finalHeight > (pageHeight - margin * 2)) {
            finalHeight = pageHeight - (margin * 2); finalWidth = (imgWidth * finalHeight) / imgHeight;
          }
          doc.addImage(pdfImg, 'JPEG', (pageWidth - finalWidth) / 2, margin, finalWidth, finalHeight);
          resolve(doc.output('datauristring'));
        };
        pdfImg.src = compressedSrc;
      };
      img.src = imageSrc;
    });
  };

  // --- 最終保存処理 ---
  const handleSave = async () => {
    if (!processedImage) {
      setStatus('画像が正しく処理されていません。');
      return;
    }
    if (GAS_URL === 'ここにGASのデプロイURLを貼り付けてください' || !GAS_URL) return;

    setIsLoading(true);
    setStatus('クラウドに保存中...');

    try {
      let fileData;
      let filename;
      const timestamp = new Date().toLocaleString('ja-JP').replace(/[\/\s:]/g, '');

      // カテゴリーに応じたデータ作成 (PDFかJPEGか)
      if (selectedCategory === 'kids') {
        // 子供写真(JPG)の時だけ、アップロード前に圧縮して容量削減する（最大長辺1200px）
        fileData = await compressToJpegBase64(processedImage, 1200, 0.85);
        filename = `子供写真_${timestamp}.jpg`;
      } else {
        // 書類系(PDF)の時は、高解像度のままPDFにして文字潰れを防ぐ
        fileData = await getPdfBase64(processedImage);
        let prefix = '書類';
        if (selectedCategory === 'receipt') prefix = '領収証';
        if (selectedCategory === 'payslip') prefix = '給与明細';
        if (selectedCategory === 'important') prefix = '重要書類';
        filename = `${prefix}_${timestamp}.pdf`;
      }

      const response = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          action: 'save',
          category: selectedCategory,
          fileData: fileData,
          filename: filename,
          comment: comment,
          year: getFiscalYear(),
          customFolder: customFolder
        })
      });

      const responseData = await response.json();

      if (responseData.success) {
        setStatus(`✅ 保存完了！`);
        // 全てリセットして最初の画面へ戻る
        setTimeout(() => {
          setCapturedImage(null);
          setProcessedImage(null);
          setComment('');
          setCustomFolder('');
          setStatus('');
          setStep(1);
        }, 3000);
      } else {
        setStatus(`❌ エラー: ${responseData.error}`);
      }

    } catch (error) {
      setStatus(`❌ 予期せぬエラー: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // ------------------------------------------------------------------
  // UI 表示部分
  // ------------------------------------------------------------------
  const btnStyle = (selected, color) => ({
    background: selected ? color : '#f0f0f0',
    color: selected ? 'white' : '#333',
    padding: '12px 10px', border: selected ? '1px solid '+color : '1px solid #ddd',
    borderRadius: '8px', cursor: 'pointer', fontWeight: selected ? 'bold' : 'normal',
    transition: '0.2s', fontSize: '14px', flex: 1
  });

  return (
    <div style={{ padding: '15px', textAlign: 'center', fontFamily: 'sans-serif', maxWidth: '500px', margin: '0 auto' }}>
      <h2 style={{ marginBottom: '5px' }}>PrintUploader</h2>
      <p style={{ color: '#666', fontSize: '13px', marginTop: '0', marginBottom: '15px' }}>{getFiscalYear()} 保存受付中</p>

      {/* -------------------- ステップ1: 撮影 -------------------- */}
      {step === 1 && (
        <div style={{ marginTop: '30px' }}>
          <input type="file" accept="image/*" capture="environment" ref={fileInputRef} onChange={handleCapture} style={{ display: 'none' }} />
          <button onClick={() => fileInputRef.current.click()} disabled={isLoading} style={{ width: '100%', padding: '20px', fontSize: '18px', background: '#333', color: 'white', border: 'none', borderRadius: '12px', cursor: 'pointer', boxShadow: '0 4px 6px rgba(0,0,0,0.2)' }}>
            📸 写真を撮る / 選ぶ
          </button>
        </div>
      )}

      {/* -------------------- ステップ2: トリミング・編集 -------------------- */}
      {step === 2 && capturedImage && (
        <div style={{ background: '#f9f9f9', padding: '15px', borderRadius: '12px', boxShadow: '0 2px 5px rgba(0,0,0,0.1)' }}>
          <p style={{ fontWeight: 'bold', margin: '0 0 10px 0' }}>画像のトリミング・調整</p>
          <p style={{ fontSize: '12px', color: '#666', margin: '0 0 15px 0' }}>写真の残したい部分を四角く囲んでください。</p>
          
          <div style={{ border: '1px solid #ddd', borderRadius: '8px', overflow: 'hidden', background: '#e0e0e0', marginBottom: '15px' }}>
            <ReactCrop crop={crop} onChange={c => setCrop(c)} onComplete={c => setCompletedCrop(c)}>
              <img ref={imgRef} src={capturedImage} alt="Crop preview" onLoad={onImageLoad} style={{ maxHeight: '50vh', display: 'block', margin: '0 auto' }} />
            </ReactCrop>
          </div>

          <p style={{ fontWeight: 'bold', fontSize: '14px', margin: '0 0 8px 0', textAlign: 'left' }}>画像モード選択</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5px', marginBottom: '20px' }}>
             <button onClick={() => setFilterMode('none')} style={btnStyle(filterMode === 'none', '#9E9E9E')}>🖼 原本(カラー)</button>
             <button onClick={() => setFilterMode('scanner')} style={btnStyle(filterMode === 'scanner', '#2196F3')}>📄 書類(白黒)</button>
             <button onClick={() => setFilterMode('darkText')} style={btnStyle(filterMode === 'darkText', '#607D8B')}>✏️ 薄い文字用</button>
             <button onClick={() => setFilterMode('shadow')} style={btnStyle(filterMode === 'shadow', '#FF5722')}>📷 影補正</button>
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={() => setStep(1)} style={{ flex: 1, padding: '12px', background: '#ccc', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>やり直す</button>
            <button onClick={applyCropAndFilter} style={{ flex: 2, padding: '12px', background: '#4CAF50', color: 'white', fontWeight: 'bold', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>この画像で決定 →</button>
          </div>
        </div>
      )}

      {/* -------------------- ステップ3: 保存先設定 -------------------- */}
      {step === 3 && processedImage && (
        <div style={{ background: '#f9f9f9', padding: '15px', borderRadius: '12px', boxShadow: '0 2px 5px rgba(0,0,0,0.1)', textAlign: 'left' }}>
          
          {/* ミニプレビュー */}
          <div style={{ background: '#eee', padding: '5px', borderRadius: '8px', marginBottom: '20px', textAlign: 'center' }}>
            <img src={processedImage} alt="Processed" style={{ maxHeight: '150px', borderRadius: '4px', border: '1px solid #ccc' }} />
            <br />
            <button onClick={() => setStep(2)} style={{ marginTop: '5px', fontSize: '12px', padding: '5px 10px', background: '#ccc', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>✂ 画像を再編集する</button>
          </div>

          <p style={{ fontWeight: 'bold', margin: '0 0 10px 0', borderBottom: '2px solid #ddd', paddingBottom: '5px' }}>1. 保存カテゴリ</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '20px' }}>
            <button onClick={() => handleCategoryChange('kids')} disabled={isLoading} style={btnStyle(selectedCategory === 'kids', '#4CAF50')}>🎨 子供作品</button>
            <button onClick={() => handleCategoryChange('receipt')} disabled={isLoading} style={btnStyle(selectedCategory === 'receipt', '#FF9800')}>🧾 領収証</button>
            <button onClick={() => handleCategoryChange('payslip')} disabled={isLoading} style={btnStyle(selectedCategory === 'payslip', '#2196F3')}>💰 給与明細</button>
            <button onClick={() => handleCategoryChange('important')} disabled={isLoading} style={btnStyle(selectedCategory === 'important', '#E91E63')}>🚨 重要書類</button>
          </div>

          <p style={{ fontWeight: 'bold', margin: '0 0 10px 0', borderBottom: '2px solid #ddd', paddingBottom: '5px' }}>2. 振り分け先フォルダ</p>
          <div style={{ background: 'white', padding: '10px', borderRadius: '8px', border: '1px solid #e0e0e0', marginBottom: '20px' }}>
            <p style={{ fontSize: '12px', color: '#666', margin: '0 0 5px 0' }}>※年度フォルダ（{getFiscalYear()}）内に作られます。未入力も可。</p>
            <input type="text" value={customFolder} onChange={(e) => setCustomFolder(e.target.value)} placeholder="新規作成 または 手入力..." disabled={isLoading} style={{ width: '100%', boxSizing: 'border-box', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', marginBottom: '10px' }} />
            
            {existingFolders.length > 0 && (
              <select onChange={(e) => setCustomFolder(e.target.value)} disabled={isLoading} value={customFolder} style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', background: '#f9f9f9' }}>
                <option value="">▼ 既存のフォルダから選択</option>
                {existingFolders.map((fName, i) => (<option key={i} value={fName}>{fName}</option>))}
              </select>
            )}
            {existingFolders.length === 0 && !isFetchingFolders && (
               <p style={{ fontSize: '12px', color: '#888' }}>既存フォルダは見つかりませんでした。</p>
            )}
            {isFetchingFolders && <p style={{ fontSize: '12px', color: '#2196F3' }}>検索中...</p>}
          </div>

          <p style={{ fontWeight: 'bold', margin: '0 0 10px 0', borderBottom: '2px solid #ddd', paddingBottom: '5px' }}>3. 詳細メモ (任意)</p>
          <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="内容や金額など..." disabled={isLoading} style={{ width: '100%', boxSizing: 'border-box', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', marginBottom: '20px' }} />

          <button onClick={handleSave} disabled={isLoading} style={{ width: '100%', padding: '18px', fontSize: '18px', background: '#4CAF50', color: 'white', border: 'none', borderRadius: '12px', cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 4px 6px rgba(0,0,0,0.2)' }}>
            {isLoading ? 'クラウドへアップロード中...' : '☁ クラウドに保存する'}
          </button>
        </div>
      )}

      {/* ステータス */}
      {status && <p style={{ marginTop: '20px', color: '#333', fontWeight: 'bold' }}>{status}</p>}
    </div>
  );
}

export default App;
