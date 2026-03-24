import React, { useState, useRef } from 'react';
import jsPDF from 'jspdf';
// axiosは使用せず、fetchで通信します (CORS対策のため)

// --- 【設定】GASのウェブアプリURLを貼り付けてください ---
const GAS_URL = 'https://script.google.com/macros/s/AKfycbzIrEcMF0V0KAMptSqXpNYi9AlH934TE8C3mIl13B_LgzkrUhjMqVkmKnz1L75LFaYrkA/exec';

function App() {
  const [capturedImage, setCapturedImage] = useState(null); // 撮影した写真（Base64）
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const fileInputRef = useRef(null);

  // カメラを起動して撮影（またはファイル選択）
  const handleCapture = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      setCapturedImage(e.target.result); // Base64形式
      setStatus('撮影完了。カテゴリーを選んでください。');
    };
    reader.readAsDataURL(file);
  };

  // 画像をリサイズ・圧縮してBase64化する（子供写真用）
  const getImageBase64 = async (imageSrc) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1200; // このサイズに収まるように縮小
        const MAX_HEIGHT = 1200;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height = Math.round(height * (MAX_WIDTH / width));
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width = Math.round(width * (MAX_HEIGHT / height));
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // 第2引数の 0.8 は画質（0.0〜1.0）。サイズを落とすために使用
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = imageSrc;
    });
  };

  // 画像をリサイズしてPDF（Base64）に変換（領収証・給与明細用）
  const getPdfBase64 = async (imageSrc) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        // --- まず画像をCanvasでリサイズ（ファイル容量削減のため） ---
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1200;
        const MAX_HEIGHT = 1200;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height = Math.round(height * (MAX_WIDTH / width));
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width = Math.round(width * (MAX_HEIGHT / height));
            height = MAX_HEIGHT;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        
        // 品質を0.8に落とし、軽量化して取得する
        const compressedBase64 = canvas.toDataURL('image/jpeg', 0.8);

        // --- 次にPDF化 ---
        const compressedImg = new Image();
        compressedImg.onload = () => {
          const doc = new jsPDF();
          
          // PDFの余白とサイズを計算
          const pageWidth = doc.internal.pageSize.getWidth();
          const pageHeight = doc.internal.pageSize.getHeight();
          const margin = 10;
          const targetWidth = pageWidth - (margin * 2);
          
          let imgWidth = compressedImg.width;
          let imgHeight = compressedImg.height;
          let finalWidth = targetWidth;
          let finalHeight = (imgHeight * finalWidth) / imgWidth;

          if (finalHeight > (pageHeight - margin * 2)) {
            finalHeight = pageHeight - (margin * 2);
            finalWidth = (imgWidth * finalHeight) / imgHeight;
          }

          doc.addImage(compressedImg, 'JPEG', (pageWidth - finalWidth) / 2, margin, finalWidth, finalHeight);
          const pdfBase64 = doc.output('datauristring'); // data:application/pdf;base64,...
          resolve(pdfBase64);
        };
        compressedImg.src = compressedBase64;
      };
      img.src = imageSrc;
    });
  };

  // カテゴリー選択と送信処理
  const handleSave = async (category) => {
    if (!capturedImage) {
      setStatus('まず写真を撮ってください。');
      return;
    }

    if (GAS_URL === 'ここにGASのデプロイURLを貼り付けてください') {
      setStatus('エラー: GAS_URL が設定されていません。App.jsx を修正してください。');
      return;
    }

    setIsLoading(true);
    setStatus('バックグラウンドで保存中...');

    try {
      let fileData;
      let filename;
      const timestamp = new Date().toLocaleString('ja-JP').replace(/[\/\s:]/g, '');

      // カテゴリーに応じたデータ作成
      if (category === 'kids') {
        fileData = await getImageBase64(capturedImage);
        filename = `子供写真_${timestamp}.jpg`;
      } else {
        // PDFに変換（領収証または給与明細）
        fileData = await getPdfBase64(capturedImage);
        filename = category === 'receipt' ? `領収証_${timestamp}.pdf` : `給与明細_${timestamp}.pdf`;
      }

      // GASのAPIへPOST送信（fetch + text/plain でCORS回避）
      const response = await fetch(GAS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
        },
        body: JSON.stringify({
          category: category,
          fileData: fileData,
          filename: filename,
          comment: comment
        })
      });

      const responseData = await response.json();

      if (responseData.success) {
        setStatus(`✅ 保存が完了しました！ (${responseData.name})`);
        // 状態をリセット
        setCapturedImage(null);
        setComment('');
        // 3秒後にメッセージを消す
        setTimeout(() => setStatus(''), 3000);
      } else {
        setStatus(`❌ エラー: ${responseData.error}`);
      }

    } catch (error) {
      setStatus(`❌ 予期せぬエラーが発生しました: ${error.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  // UI
  return (
    <div style={{ padding: '20px', textAlign: 'center', fontFamily: 'sans-serif', maxWidth: '500px', margin: '0 auto' }}>
      <h2>作品・書類アップローダー</h2>
      
      {/* 撮影ボタン */}
      <input type="file" accept="image/*" capture="environment" ref={fileInputRef} onChange={handleCapture} style={{ display: 'none' }} />
      <button onClick={() => fileInputRef.current.click()} disabled={isLoading} style={{ margin: '10px', padding: '15px 30px', fontSize: '18px', background: '#e0e0e0', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>
        📸 写真を撮る / 選ぶ
      </button>

      {/* プレビュー */}
      {capturedImage && (
        <div style={{ marginTop: '15px' }}>
          <img src={capturedImage} alt="Captured" style={{ maxWidth: '100%', maxHeight: '60vw', display: 'block', margin: 'auto', borderRadius: '8px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }} />
        </div>
      )}

      {/* カテゴリー選択ボタン（撮影完了時のみ表示） */}
      {capturedImage && (
        <div style={{ marginTop: '20px', padding: '20px', background: '#f5f5f5', borderRadius: '12px' }}>
          <p style={{ fontWeight: 'bold' }}>カテゴリーを選んで保存</p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '15px' }}>
            <button onClick={() => handleSave('kids')} disabled={isLoading} style={{ background: '#4CAF50', color: 'white', padding: '12px 20px', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>🎨 子供作品</button>
            <button onClick={() => handleSave('receipt')} disabled={isLoading} style={{ background: '#FF9800', color: 'white', padding: '12px 20px', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>🧾 領収証</button>
            <button onClick={() => handleSave('payslip')} disabled={isLoading} style={{ background: '#2196F3', color: 'white', padding: '12px 20px', border: 'none', borderRadius: '8px', cursor: 'pointer' }}>💰 給与明細</button>
          </div>

          {/* コメント入力 */}
          <div style={{ marginTop: '20px' }}>
            <input type="text" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="メモや金額など（任意）" disabled={isLoading} style={{ width: '100%', boxSizing: 'border-box', padding: '12px', borderRadius: '8px', border: '1px solid #ccc' }} />
          </div>
        </div>
      )}

      {/* ステータス */}
      <p style={{ marginTop: '20px', minHeight: '30px', color: '#333', fontWeight: 'bold' }}>{status}</p>
    </div>
  );
}

export default App;
