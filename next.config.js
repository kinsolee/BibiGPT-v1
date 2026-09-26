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
    const rewrites = [
      {
        source: '/blocked',
        destination: '/shop',
      },
    ]
    // 未配置或非完整 URL（如裸 hostname）时跳过该 rewrite，避免 next build 校验失败
    const internalApiHostname = process.env.INTERNAL_API_HOSTNAME || ''
    if (/^https?:\/\//.test(internalApiHostname)) {
      rewrites.unshift({
        source: '/api/:path*',
        destination: `${internalApiHostname}/api/:path*`,
      })
    }
    return rewrites
  },
}

const shouldEnableSentry = Boolean(process.env.SENTRY_AUTH_TOKEN)

module.exports = shouldEnableSentry
  ? withSentryConfig(nextConfig, { silent: true }, { hideSourceMaps: true })
  : nextConfig
