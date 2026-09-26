// This file sets a custom webpack configuration to use your Next.js app
// with Sentry.
// https://nextjs.org/docs/api-reference/next.config.js/introduction
// https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
const { withSentryConfig } = require('@sentry/nextjs')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: process.env.SUPABASE_HOSTNAME || 'xxxx.supabase.co', // to prevent vercel failed
      },
      {
        protocol: 'https',
        hostname: 'b.jimmylv.cn',
      },
      {
        protocol: 'https',
        hostname: 'bibigpt.co',
      },
      {
        protocol: 'https',
        hostname: 'avatars.dicebear.com',
      },
    ],
  },
  async rewrites() {
    // afterFiles rewrite 优先于动态路由匹配：若这里保留 /api/:path* 通配，
    // 本地 /api/history/[id] 等动态 API 路由会被整体劫持到外部主机。
    // 仓库内唯一无本地路由文件、需要内部服务代理的端点是 /api/b23tv（见 pages/[...slug].tsx）；
    // 内部服务新增端点时需在此显式追加。未配置或非完整 URL（裸 hostname）时跳过，避免 build 校验失败。
    const internalApiHostname = process.env.INTERNAL_API_HOSTNAME || ''
    if (!/^https?:\/\//.test(internalApiHostname)) {
      return [{ source: '/blocked', destination: '/shop' }]
    }
    return [
      {
        source: '/api/b23tv',
        destination: `${internalApiHostname}/api/b23tv`,
      },
      {
        source: '/blocked',
        destination: '/shop',
      },
    ]
  },
}

const shouldEnableSentry = Boolean(process.env.SENTRY_AUTH_TOKEN)

module.exports = shouldEnableSentry
  ? withSentryConfig(nextConfig, { silent: true }, { hideSourceMaps: true })
  : nextConfig
