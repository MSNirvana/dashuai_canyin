// ═══════════════════════════════════════════════════════════════
// PM2 进程配置
//   落地位置：/opt/dashuai/deploy/ecosystem.config.cjs
//   启动：pm2 start deploy/ecosystem.config.cjs --update-env
//
// .env 由服务自己加载（src/env.ts 里 import 'dotenv/config'，按 cwd 找 ./.env），
// 所以这里只要 cwd 对，不需要再声明 env_file。
//
// 为什么只起一个进程：
//   src/index.ts:99-107 在 FFMPEG_WORKER=true 时会在 API 进程内直接拉起 render worker，
//   生产校验又强制 FFMPEG_WORKER=true，所以再单独起一个 worker 进程属于重复。
//   单机测试版正确做法就是只跑 API 进程，日志集中、无并发干扰。
//   （多开也不会重复处理任务——worker 用 updateMany 条件更新抢锁，见 src/render/worker.ts:94。
//     真正需要拆分时，把下面的 api-worker 取消注释、并把 index.ts 的内嵌启动改成按环境变量关闭。）
// ═══════════════════════════════════════════════════════════════

module.exports = {
  apps: [
    {
      name: 'dashuai-api',
      cwd: '/opt/dashuai/server',
      script: 'dist/index.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // 合成期间内存峰值高，别设太低否则跑到一半被重启
      max_memory_restart: '3G',
      kill_timeout: 15000,
      out_file: '/var/log/dashuai/api.out.log',
      error_file: '/var/log/dashuai/api.err.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'staging',
      },
    },
    // {
    //   name: 'dashuai-api-worker',
    //   cwd: '/opt/dashuai/server',
    //   script: 'dist/render/run-worker.js',
    //   interpreter: 'node',
    //   instances: 1,
    //   exec_mode: 'fork',
    //   autorestart: true,
    //   max_memory_restart: '3G',
    //   out_file: '/var/log/dashuai/worker.out.log',
    //   error_file: '/var/log/dashuai/worker.err.log',
    //   time: true,
    // },
  ],
}
