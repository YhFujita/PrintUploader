import React, { useState, useRef, useEffect } from 'react';
import jsPDF from 'jspdf';
// axiosは使用せず、fetchで通信します (CORS対策のため)

// --- 【設定】GASのウェブアプリURLを貼り付けてください ---
const GAS_URL = 'https://script.google.com/macros/s/AKfycbzQgb7mJclr_yrvDCpVrjjv_V95uU6uLXGIUYpBfQxO7_gwexRr6iUy0IDs1DoduwPW/exec';

function App() {
  const [capturedImage, setCapturedImage] = useState(null); // 撮影した写真（Base64）
  
  // ユーザー入力・選択用の状態
  const [selectedCategory, setSelectedCategory] = useState('kids'); // 初期カテゴリ
  const [comment, setComment] = useState('');
  const [customFolder, setCustomFolder] = useState(''); // 任意指定のサブフォルダ名
  
  // GASと通信するための状態
  const [existingFolders, setExistingFolders] = useState([]); // GASから取得した既存のフォルダ名リスト
  const [isFetchingFolders, setIsFetchingFolders] = useState(false);
  
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const fileInputRef = useRef(null);

  // 日本独自式の「年度」（4月始まり〜翌3月）を計算する関数
  const getFiscalYear = () => {
    const d = new Date();
    const currentYear = d.getFullYear();
    const currentMonth = d.getMonth() + 1; // 1~12
    // 1月〜3月は「前年度」になる
    if (currentMonth >= 1 && currentMonth <= 3) {
      return `${currentYear - 1}年度`;
    }
    return `${currentYear}年度`;
  };

  // カメラを起動して撮影（またはファイル選択）
  const handleCapture = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      setCapturedImage(e.target.result);
      setStatus('撮影完了。必要に応じてフォルダ名を指定し、「この内容で保存」を押してください。');
      
      // 撮影直後に、現在選択されているカテゴリの既存フォルダリストを自動的に取得する
      fetchExistingFolders(selectedCategory);
    };
    reader.readAsDataURL(file);
  };

  // カテゴリが手動で変更されたときに、そのカテゴリの既存フォルダ候補を取り直す
  const handleCategoryChange = (category) => {
    setSelectedCategory(category);
    setCustomFolder(''); // カテゴリを変更したら入力中のフォルダ名はリセット
    setExistingFolders([]);
    if (capturedImage) {
      fetchExistingFolders(category);
    }
  };

  // GASへ問い合わせて、作成済みのサブフォルダ一覧を取得する関数
  const fetchExistingFolders = async (category) => {
    if (GAS_URL === 'ここにGASのデプロイURLを貼り付けてください' || !GAS_URL) return;
    setIsFetchingFolders(true);
    setStatus('作成済みフォルダの候補を取得中...');
    try {
      const response = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({
          action: 'getFolders',
          category: category,
          year: getFiscalYear()
        })
      });
      const data = await response.json();
      if (data.success) {
        setExistingFolders(data.folders || []);
        setStatus('準備完了。保存先を設定してください。');
      } else {
        setStatus(`⚠ フォルダリストの取得に失敗: ${data.error}`);
      }
    } catch (error) {
      setStatus(`⚠ ネットワークエラー: フォルダリストを取得できませんでした`);
    } finally {
      setIsFetchingFolders(false);
    }
  };

  // ----------- 画像圧縮・PDF化ロジック (変更点は軽量化のみ) -----------
  const getImageBase64 = async (imageSrc) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1200;
        const MAX_HEIGHT = 1200;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) { height = Math.round(height * (MAX_WIDTH / width)); width = MAX_WIDTH; }
        } else {
          if (height > MAX_HEIGHT) { width = Math.round(width * (MAX_HEIGHT / height)); height = MAX_HEIGHT; }
        }

        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = imageSrc;
    });
  };

  const getPdfBase64 = async (imageSrc) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1200; const MAX_HEIGHT = 1200;
        let width = img.width; let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) { height = Math.round(height * (MAX_WIDTH / width)); width = MAX_WIDTH; }
        } else {
          if (height > MAX_HEIGHT) { width = Math.round(width * (MAX_HEIGHT / height)); height = MAX_HEIGHT; }
        }
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        
        const compressedBase64 = canvas.toDataURL('image/jpeg', 0.8);
        const compressedImg = new Image();
        compressedImg.onload = () => {
          const doc = new jsPDF();
          const pageWidth = doc.internal.pageSize.getWidth();
          const pageHeight = doc.internal.pageSize.getHeight();
          const margin = 10;
          const targetWidth = pageWidth - (margin * 2);
          
          let imgWidth = compressedImg.width; let imgHeight = compressedImg.height;
          let finalWidth = targetWidth; let finalHeight = (imgHeight * finalWidth) / imgWidth;

          if (finalHeight > (pageHeight - margin * 2)) {
            finalHeight = pageHeight - (margin * 2); finalWidth = (imgWidth * finalHeight) / imgHeight;
          }
          doc.addImage(compressedImg, 'JPEG', (pageWidth - finalWidth) / 2, margin, finalWidth, finalHeight);
          resolve(doc.output('datauristring'));
        };
        compressedImg.src = compressedBase64;
      };
      img.src = imageSrc;
    });
  };
  // ------------------------------------------------------------------


  // 最終的な保存処理
  const handleSave = async () => {
    if (!capturedImage) {
      setStatus('まず写真を撮ってください。');
      return;
    }
    if (GAS_URL === 'ここにGASのデプロイURLを貼り付けてください' || !GAS_URL) {
      setStatus('エラー: GAS_URL が正しく設定されていません。');
      return;
    }

    setIsLoading(true);
    setStatus('バックグラウンドで保存中...');

    try {
      let fileData;
      let filename;
      const timestamp = new Date().toLocaleString('ja-JP').replace(/[\/\s:]/g, '');

      // カテゴリーに応じた実データの作成（画像 or PDF）
      if (selectedCategory === 'kids') {
        fileData = await getImageBase64(capturedImage);
        filename = `子供写真_${timestamp}.jpg`;
      } else {
        // PDFに変換（領収証、給与明細、重要書類は全てPDF）
        fileData = await getPdfBase64(capturedImage);
        let prefix = '書類';
        if (selectedCategory === 'receipt') prefix = '領収証';
        if (selectedCategory === 'payslip') prefix = '給与明細';
        if (selectedCategory === 'important') prefix = '重要書類';
        
        filename = `${prefix}_${timestamp}.pdf`;
      }

      // GASのAPIへPOST送信（アクション: save を指定して年度とカスタムフォルダも送る）
      const response = await fetch(GAS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
        },
        body: JSON.stringify({
          action: 'save',
          category: selectedCategory,
          fileData: fileData,
          filename: filename,
          comment: comment,
          year: getFiscalYear(),          // 自動計算された「2026年度」などを送信
          customFolder: customFolder      // いちばん深い階層の任意フォルダ名
        })
      });

      const responseData = await response.json();

      if (responseData.success) {
        setStatus(`✅ 保存が完了しました！ (${responseData.name})`);
        setCapturedImage(null);
        setComment('');
        setCustomFolder('');
        setTimeout(() => setStatus(''), 5000);
      } else {
        setStatus(`❌ エラー: ${responseData.error}`);
      }

    } catch (error) {
      setStatus(`❌ 予期せぬエラーが発生しました: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // UIスタイリング用の簡易ヘルパー
  const btnStyle = (category, color) => ({
    background: selectedCategory === category ? color : '#e0e0e0',
    color: selectedCategory === category ? 'white' : '#333',
    padding: '12px 16px',
    border: 'none',
    borderRadius: '8px',
    cursor: 'pointer',
    fontWeight: selectedCategory === category ? 'bold' : 'normal',
    transition: '0.2s'
  });

  return (
    <div style={{ padding: '20px', textAlign: 'center', fontFamily: 'sans-serif', maxWidth: '500px', margin: '0 auto' }}>
      <h2>PrintUploader</h2>
      <p style={{ color: '#666', fontSize: '14px', marginBottom: '20px' }}>現在の保存先年度: <strong>{getFiscalYear()}</strong></p>
      
      {/* 撮影ボタン */}
      <input type="file" accept="image/*" capture="environment" ref={fileInputRef} onChange={handleCapture} style={{ display: 'none' }} />
      <button onClick={() => fileInputRef.current.click()} disabled={isLoading} style={{ width: '100%', padding: '15px', fontSize: '18px', background: '#333', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', boxShadow: '0 4px 6px rgba(0,0,0,0.2)' }}>
        📸 写真を撮る / 選ぶ
      </button>

      {/* プレビューと設定エリア */}
      {capturedImage && (
        <div style={{ marginTop: '20px', padding: '15px', background: '#f5f5f5', borderRadius: '12px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
          <img src={capturedImage} alt="Captured" style={{ maxWidth: '100%', maxHeight: '40vw', display: 'block', margin: '0 auto 15px', borderRadius: '8px', border: '1px solid #ddd' }} />
          
          <div style={{ textAlign: 'left', marginBottom: '15px' }}>
            <p style={{ fontWeight: 'bold', margin: '0 0 10px 0' }}>1. カテゴリを選択</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <button onClick={() => handleCategoryChange('kids')} disabled={isLoading} style={btnStyle('kids', '#4CAF50')}>🎨 子供作品</button>
              <button onClick={() => handleCategoryChange('receipt')} disabled={isLoading} style={btnStyle('receipt', '#FF9800')}>🧾 領収証</button>
              <button onClick={() => handleCategoryChange('payslip')} disabled={isLoading} style={btnStyle('payslip', '#2196F3')}>💰 給与明細</button>
              <button onClick={() => handleCategoryChange('important')} disabled={isLoading} style={btnStyle('important', '#E91E63')}>🚨 重要書類</button>
            </div>
          </div>

          <div style={{ textAlign: 'left', marginBottom: '15px', padding: '10px', background: 'white', borderRadius: '8px', border: '1px solid #e0e0e0' }}>
            <p style={{ fontWeight: 'bold', margin: '0 0 8px 0', fontSize: '14px' }}>
              2. 任意サブフォルダ名 (空欄でも可)
            </p>
            <p style={{ fontSize: '12px', color: '#888', margin: '0 0 8px 0' }}>
              ※ 年度フォルダの下にさらに分類フォルダ（例: 住宅ローン等）を作ります。
            </p>
            
            <div style={{ display: 'flex', gap: '5px', marginBottom: '10px' }}>
              <input type="text" value={customFolder} onChange={(e) => setCustomFolder(e.target.value)} placeholder="新規作成 または 手入力..." disabled={isLoading} style={{ flex: 1, padding: '10px', borderRadius: '6px', border: '1px solid #ccc' }} />
            </div>

            {/* 作成済みフォルダからの選択 (リストがある場合のみ表示) */}
            {existingFolders.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <select 
                  onChange={(e) => setCustomFolder(e.target.value)} 
                  disabled={isLoading}
                  value={customFolder}
                  style={{ padding: '10px', borderRadius: '6px', border: '1px solid #ccc', background: '#f9f9f9' }}
                >
                  <option value="">▼ 既存のフォルダから選択</option>
                  {existingFolders.map((fName, i) => (
                    <option key={i} value={fName}>{fName}</option>
                  ))}
                </select>
                <button onClick={() => fetchExistingFolders(selectedCategory)} disabled={isFetchingFolders || isLoading} style={{ fontSize: '12px', padding: '5px', borderRadius: '6px', cursor: 'pointer', background: '#e0f7fa', border: '1px solid #b2ebf2' }}>
                  🔄 リストを再取得
                </button>
              </div>
            )}
            {isFetchingFolders && <p style={{ fontSize: '12px', color: '#2196F3' }}>取得中...</p>}
          </div>

          <div style={{ textAlign: 'left', marginBottom: '15px' }}>
             <p style={{ fontWeight: 'bold', margin: '0 0 8px 0', fontSize: '14px' }}>3. コメント・メモ (任意)</p>
             <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="ファイルにつける説明..." disabled={isLoading} style={{ width: '100%', boxSizing: 'border-box', padding: '10px', borderRadius: '6px', border: '1px solid #ccc' }} />
          </div>

          <button onClick={handleSave} disabled={isLoading} style={{ width: '100%', padding: '15px', fontSize: '18px', background: '#4CAF50', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 4px 6px rgba(0,0,0,0.2)' }}>
            {isLoading ? '保存中...' : 'クラウドに保存する'}
          </button>
        </div>
      )}

      {/* ステータス */}
      <p style={{ marginTop: '20px', minHeight: '30px', color: '#333', fontWeight: 'bold' }}>{status}</p>
    </div>
  );
}

export default App;
