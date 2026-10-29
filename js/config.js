/**
 * フロントエンド設定
 * - API_URL : Vercel Serverless Function のエンドポイント (例: '/api/budget')
 * - GAS_URL : 従来のGASウェブアプリURL (後方互換フォールバック)
 * - LIFF_ID : LINE DevelopersのLIFF ID (例: 2012227672-F2wXP3LP)
 * ここに設定するとLINE内ブラウザでも自動で読み込まれます。
 */
window.PAIRBUDGET_CONFIG = {
  API_URL: '/api/budget',
  GAS_URL: 'https://script.google.com/macros/s/AKfycbwaoyykTS6nL-vSYfiKOdZokLMtqn675iG0ltZX-H2DkVTs6BLSw9mAYc6sQiKFr9aJTw/exec',
  LIFF_ID: '2012227672-F2wXP3LP'
};
