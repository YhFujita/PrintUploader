/**
 * PrintUploader用 Google Apps Script (バックエンドロジック - フェーズ2対応版)
 *
 * 【機能】
 * - CORSエラーを回避するため、基本的にPOST(text/plain)で処理を受け付けます。
 * - アクション(action)によって「save（保存）」と「getFolders（フォルダ一覧取得）」を切り替えます。
 * - {ルート} > {カテゴリ} > {年度} > {カスタムフォルダ} の多重階層を構築して保存します。
 */

function getOrCreateFolder(parentFolder, folderName) {
  var folders = parentFolder.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  } else {
    return parentFolder.createFolder(folderName);
  }
}

// カテゴリ識別子を日本語フォルダ名に変換する関数
function getCategoryFolderName(category) {
  var categoryFolderName = category;
  if (category === "kids") categoryFolderName = "子供写真";
  if (category === "receipt") categoryFolderName = "領収証";
  if (category === "payslip") categoryFolderName = "給与明細";
  if (category === "important") categoryFolderName = "重要書類";
  return categoryFolderName;
}

function doPost(e) {
  try {
    // text/plainやapplication/jsonで送られてきたPostデータをパース
    var textData = e.postData.contents;
    var data = JSON.parse(textData);
    
    var action = data.action || "save";
    var category = data.category || "important";
    var year = data.year || "不明な年度";
    
    // -----------------------------------------------------------------
    // アクション: getFolders (指定されたカテゴリ・年度の既存サブフォルダ名リストを返す)
    // -----------------------------------------------------------------
    if (action === "getFolders") {
      var rootFolderForGet = getOrCreateFolder(DriveApp.getRootFolder(), "PrintUploader");
      var categoryFolderForGet = getOrCreateFolder(rootFolderForGet, getCategoryFolderName(category));
      var yearFolderForGet = getOrCreateFolder(categoryFolderForGet, year);
      
      var subFoldersIter = yearFolderForGet.getFolders();
      var folderList = [];
      while (subFoldersIter.hasNext()) {
        folderList.push(subFoldersIter.next().getName());
      }
      
      // JSONで返す
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        folders: folderList
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    // -----------------------------------------------------------------
    // アクション: save (ファイルのアップロード・生成)
    // -----------------------------------------------------------------
    if (action === "save") {
      var fileData = data.fileData; // "data:image/jpeg;base64,..." 等
      var filename = data.filename;
      var comment = data.comment || "";
      var customFolder = data.customFolder || ""; // 後から追加した任意のサブフォルダ名

      // Base64の実データ部分（カンマ以降）を取得してBlob化
      var base64Data = fileData.indexOf(',') !== -1 ? fileData.split(',')[1] : fileData;
      var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), "", filename);
      
      // MIMEタイプの推測・設定
      if (fileData.indexOf('application/pdf') > -1 || filename.indexOf('.pdf') > -1) {
        blob.setContentType('application/pdf');
      } else if (fileData.indexOf('image/jpeg') > -1 || fileData.indexOf('image/jpg') > -1 || filename.indexOf('.jpg') > -1) {
        blob.setContentType('image/jpeg');
      } else if (fileData.indexOf('image/png') > -1 || filename.indexOf('.png') > -1) {
        blob.setContentType('image/png');
      }

      // {ルート: PrintUploader} > {カテゴリ: 子供写真等} > {年度} > {カスタムフォルダ} の順に作成
      var rootFolder = getOrCreateFolder(DriveApp.getRootFolder(), "PrintUploader");
      var categoryFolder = getOrCreateFolder(rootFolder, getCategoryFolderName(category));
      var yearFolder = getOrCreateFolder(categoryFolder, year);
      
      // 最終的な保存先ターゲットフォルダ（カスタム名が指定されていた場合、その階層を作る）
      var targetFolder = yearFolder;
      if (customFolder && customFolder.trim() !== "") {
        targetFolder = getOrCreateFolder(yearFolder, customFolder.trim());
      }
      
      // ファイル作成
      var file = targetFolder.createFile(blob);
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
    }

    // 存在しないアクションの場合
    return ContentService.createTextOutput(JSON.stringify({ success: false, error: "無効なアクションです" }))
        .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    var errResult = {
      success: false,
      error: error.toString()
    };
    return ContentService.createTextOutput(JSON.stringify(errResult))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// 念のためOPTIONS対策
function doOptions(e) {
  return ContentService.createTextOutput("")
    .setMimeType(ContentService.MimeType.TEXT);
}