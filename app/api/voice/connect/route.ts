// Voice session bootstrap — starts a Pipecat Cloud agent session and returns
// the Daily room credentials to the browser.
//
// The browser never sees PIPECAT_CLOUD_API_KEY: it POSTs here, we call Pipecat
// Cloud's start endpoint server-side, and hand back { dailyRoom, dailyToken }.
// @pipecat-ai/daily-transport consumes those field names directly.
//
// Same route works on localhost (next dev) and on Vercel — only the env var
// location differs (.env.local vs Vercel project env).

export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'

const AGENT = process.env.PIPECAT_AGENT_NAME || 'curio-voice'
const START_URL = `https://api.pipecat.daily.co/v1/public/${AGENT}/start`

export async function POST(req: NextRequest) {
  const apiKey = process.env.PIPECAT_CLOUD_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: 'PIPECAT_CLOUD_API_KEY is not set on the server.' },
      { status: 500 },
    )
  }

  // The browser may send a session payload (conversationId, systemPrompt, …);
  // it rides through Pipecat Cloud into the bot as runner_args.body["session"].
  let session: unknown = {}
  try {
    const json = await req.json()
    session = json?.session ?? {}
  } catch {
    // No/invalid body — start with an empty session context.
  }

  let upstream: Response
  try {
    upstream = await fetch(START_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ createDailyRoom: true, body: { session } }),
    })
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to reach Pipecat Cloud: ${(err as Error).message}` },
      { status: 502 },
    )
  }

  const text = await upstream.text()
  if (!upstream.ok) {
    return NextResponse.json(
      { error: 'Pipecat Cloud start failed', status: upstream.status, detail: text.slice(0, 500) },
      { status: 502 },
    )
  }

  // Pass the start response straight through: { dailyRoom, dailyToken, sessionId }.
  // DailyTransport maps dailyRoom -> url and dailyToken -> token on connect().
  return new NextResponse(text, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
