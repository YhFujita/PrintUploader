/**
 * PrintUploader用 Google Apps Script (バックエンドロジック)
 *
 * 【機能】
 * - HTTP POST リクエストを受け取り、Base64画像をパース
 * - 自身のマイドライブ直下に「PrintUploader」フォルダが存在しなければ作成
 * - カテゴリ（kids, receipt, payslip）に応じたサブフォルダが存在しなければ作成
 * - 指定されたフォルダ内にファイル（PDF/JPEG）を作成して保存
 *
 * 【デプロイ手順】
 * 1. Google Driveを開き、「＋新規」>「その他」>「Google Apps Script」を作成
 * 2. プロジェクト名を「PrintUploader API」などに変更
 * 3. このファイル(GoogleAppsScript.js)の内容を Code.gs にすべて貼り付け
 * 4. 右上の「デプロイ」>「新しいデプロイ」をクリック
 * 5. 「種類の選択」の歯車アイコンから「ウェブアプリ」を選択
 * 6. 説明（任意）を入力
 * 7. 次のユーザーとして実行: 「自分（あなたのGoogleアカウント）」
 * 8. アクセスできるユーザー: 「全員」
 * 9. 「デプロイ」をクリック（初回はアクセス承認が求められるので許可してください）
 * 10. 表示される「ウェブアプリのURL」をコピーし、React側の `App.jsx` に設定してください。
 */

function getOrCreateFolder(parentFolder, folderName) {
  var folders = parentFolder.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  } else {
    return parentFolder.createFolder(folderName);
  }
}

function doPost(e) {
  try {
    // text/plainやapplication/jsonで送られてきたPostデータをパース
    var textData = e.postData.contents;
    var data = JSON.parse(textData);
    
    var category = data.category;
    var fileData = data.fileData; // "data:image/jpeg;base64,..." 等
    var filename = data.filename;
    var comment = data.comment || "";

    // データのカンマ以降を取得 (Base64の実データ部分)
    var base64Data = fileData.indexOf(',') !== -1 ? fileData.split(',')[1] : fileData;
    var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), "", filename);
    
    // MIMEタイプの設定
    if (fileData.indexOf('application/pdf') > -1 || filename.indexOf('.pdf') > -1) {
      blob.setContentType('application/pdf');
    } else if (fileData.indexOf('image/jpeg') > -1 || fileData.indexOf('image/jpg') > -1 || filename.indexOf('.jpg') > -1) {
      blob.setContentType('image/jpeg');
    } else if (fileData.indexOf('image/png') > -1 || filename.indexOf('.png') > -1) {
      blob.setContentType('image/png');
    }

    // 保存先フォルダの決定
    // "PrintUploader" フォルダをルート（マイドライブ直下）に探すか作成する
    var rootFolder = getOrCreateFolder(DriveApp.getRootFolder(), "PrintUploader");
    
    // カテゴリごとのサブフォルダを作成
    var categoryFolderName = category;
    if (category === "kids") categoryFolderName = "子供写真";
    if (category === "receipt") categoryFolderName = "領収証";
    if (category === "payslip") categoryFolderName = "給与明細";
    
    var targetFolder = getOrCreateFolder(rootFolder, categoryFolderName);
    
    // ファイル作成
    var file = targetFolder.createFile(blob);
    
    // コメントがあれば説明（Description）に追加する
    if (comment) {
      file.setDescription(comment);
    }
    
    var result = {
      success: true,
      name: file.getName(),
      url: file.getUrl(),
      message: "Success!"
    };
    
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    var result = {
      success: false,
      error: error.toString()
    };
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// 念のためOPTIONS対策
function doOptions(e) {
  return ContentService.createTextOutput("")
    .setMimeType(ContentService.MimeType.TEXT);
}