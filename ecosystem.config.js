// PM2 プロセス定義（常駐起動・自動再起動用）
// 使い方: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: "citadel",
      script: "server.js",
      instances: 1,            // Socket.IO の部屋状態をメモリ保持するため単一プロセスで運用
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
    },
  ],
};
