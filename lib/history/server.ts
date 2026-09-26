import { createServerSupabaseClient } from '@supabase/auth-helpers-nextjs'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

export function getHistorySupabase(req: NextApiRequest, res: NextApiResponse): SupabaseClient {
  return createServerSupabaseClient({ req, res }) as SupabaseClient
}

export async function requireUserId(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<{ supabase: SupabaseClient; userId: string } | null> {
  const supabase = getHistorySupabase(req, res)
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user) {
    res.status(401).json({ error: 'unauthorized', message: '登录后才能访问历史记录' })
    return null
  }
  return { supabase, userId: user.id }
}
