const GIST_ID = '5d4040952ba2e2580b37e422df659d40'

async function handleSync(request, env) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: cors })
  }

  const token = env.GIST_TOKEN
  if (!token) {
    return new Response(JSON.stringify({ error: 'missing token' }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'plan-de-table-sync',
  }

  if (request.method === 'GET') {
    const gh = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers })
    if (!gh.ok) {
      return new Response(JSON.stringify({ error: 'gist fetch failed' }), {
        status: gh.status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    const gist = await gh.json()
    const raw = gist.files?.['state.json']?.content ?? 'null'
    return new Response(raw, {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  if (request.method === 'PUT') {
    const text = await request.text()
    JSON.parse(text)
    const gh = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: { 'state.json': { content: text } },
      }),
    })
    if (!gh.ok) {
      return new Response(JSON.stringify({ error: 'gist update failed' }), {
        status: gh.status,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  }

  return new Response('Method not allowed', { status: 405, headers: cors })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/api/state' || url.pathname === '/api/state/') {
      return handleSync(request, env)
    }
    // Static assets handled by [assets] binding automatically when using
    // Workers + Assets — fall through for non-API paths.
    return env.ASSETS.fetch(request)
  },
}
